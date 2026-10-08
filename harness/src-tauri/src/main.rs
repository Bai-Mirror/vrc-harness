// Windows: a windowed program, so starting Harness opens no console window beside it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct GuiHost(Mutex<Option<Child>>);
struct GuiBridge {
    port: u16,
    token: String,
}

fn store_booth_session(app: &tauri::AppHandle, session: &str) -> Result<(), String> {
    let bridge = app.state::<GuiBridge>();
    let body = serde_json::to_string(&serde_json::json!({
        "method": "booth.session.set",
        "params": { "session": session }
    }))
    .map_err(|error| error.to_string())?;
    let mut stream = TcpStream::connect(("127.0.0.1", bridge.port))
        .map_err(|error| format!("无法连接 Harness Runtime：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    write!(
        stream,
        "POST /api/native-call HTTP/1.0\r\nHost: 127.0.0.1\r\nX-AVH-Native-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        bridge.token,
        body.len(),
        body
    )
    .map_err(|error| format!("无法保存 BOOTH 登录态：{error}"))?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Runtime 未返回 BOOTH 登录结果：{error}"))?;
    if !response.starts_with("HTTP/1.1 200 ") && !response.starts_with("HTTP/1.0 200 ") {
        return Err("Harness Runtime 拒绝保存 BOOTH 登录态".into());
    }
    Ok(())
}

// async: building a window from a synchronous command deadlocks on Windows (WebView2 creates it on the main thread).
#[tauri::command]
async fn open_booth_login(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the Harness window may open BOOTH login".into());
    }
    if let Some(existing) = app.get_webview_window("booth-login") {
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "booth-login",
        WebviewUrl::External("https://accounts.booth.pm/library".parse().map_err(|error| format!("{error}"))?),
    )
    .title("登录 BOOTH · Harness")
    .inner_size(1080.0, 760.0)
    .min_inner_size(760.0, 560.0)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn capture_booth_session(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the Harness window may capture BOOTH login".into());
    }
    let login = app.get_webview_window("booth-login").ok_or("请先打开 BOOTH 登录窗口")?;
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{CookieManagerExt, WebContextExt, WebViewExt};
        let (sender, receiver) = futures_channel::oneshot::channel();
        login.with_webview(move |platform| {
            let view = platform.inner();
            let Some(context) = view.context() else { let _ = sender.send(Err("BOOTH WebView 没有 Cookie 上下文".into())); return; };
            let Some(manager) = context.cookie_manager() else { let _ = sender.send(Err("无法读取 BOOTH Cookie Store".into())); return; };
            manager.cookies("https://accounts.booth.pm/", None::<&webkit2gtk::gio::Cancellable>, move |result| {
                let session = result.map_err(|error| error.to_string()).and_then(|cookies| cookies.into_iter().find_map(|mut cookie| {
                    (cookie.name().as_deref() == Some("_plaza_session_nktz7u")).then(|| cookie.value().map(|value| value.to_string())).flatten()
                }).ok_or_else(|| "尚未检测到 BOOTH 登录态，请在登录窗口完成登录后重试".to_string()));
                let _ = sender.send(session);
            });
        }).map_err(|error| error.to_string())?;
        let session = receiver.await.map_err(|_| "读取 BOOTH 登录态时窗口已关闭".to_string())??;
        store_booth_session(&app, &session)?;
        let _ = login.close();
        return Ok(());
    }
    #[cfg(windows)]
    {
        use std::sync::Arc;
        use webview2_com::{GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_2};
        use windows_core::{Interface, HSTRING};
        let (sender, receiver) = futures_channel::oneshot::channel::<Result<String, String>>();
        // Answered once, by the cookie callback or by the failure to start the read, whichever comes.
        let sender = Arc::new(Mutex::new(Some(sender)));
        let reply = move |result: Result<String, String>| {
            if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = sender.send(result);
            }
        };
        login.with_webview(move |platform| {
            let failed = reply.clone();
            let started = (|| -> windows_core::Result<()> {
                let manager = unsafe { platform.controller().CoreWebView2()?.cast::<ICoreWebView2_2>()?.CookieManager()? };
                let handler = GetCookiesCompletedHandler::create(Box::new(move |status, cookies| {
                    reply(status.map_err(|error| error.to_string()).and_then(|()| booth_session_cookie(cookies)));
                    Ok(())
                }));
                unsafe { manager.GetCookies(&HSTRING::from("https://accounts.booth.pm/"), &handler) }
            })();
            if let Err(error) = started {
                failed(Err(format!("无法读取 BOOTH Cookie：{error}")));
            }
        }).map_err(|error| error.to_string())?;
        let session = receiver.await.map_err(|_| "读取 BOOTH 登录态时窗口已关闭".to_string())??;
        store_booth_session(&app, &session)?;
        let _ = login.close();
        return Ok(());
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("当前平台暂不支持内建 BOOTH 登录".into())
}

/// The BOOTH session cookie among those WebView2 holds for accounts.booth.pm.
#[cfg(windows)]
fn booth_session_cookie(
    cookies: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>,
) -> Result<String, String> {
    use webview2_com::take_pwstr;
    use windows_core::PWSTR;
    let missing = || "尚未检测到 BOOTH 登录态，请在登录窗口完成登录后重试".to_string();
    let cookies = cookies.ok_or_else(missing)?;
    let mut count = 0u32;
    unsafe { cookies.Count(&mut count) }.map_err(|error| error.to_string())?;
    for index in 0..count {
        let cookie = unsafe { cookies.GetValueAtIndex(index) }.map_err(|error| error.to_string())?;
        let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
        unsafe { cookie.Name(&mut name) }.map_err(|error| error.to_string())?;
        if take_pwstr(name) == "_plaza_session_nktz7u" {
            unsafe { cookie.Value(&mut value) }.map_err(|error| error.to_string())?;
            return Ok(take_pwstr(value));
        }
    }
    Err(missing())
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve GUI port");
    let port = listener.local_addr().expect("GUI address").port();
    drop(listener);
    let mut token = [0u8; 24];
    getrandom::fill(&mut token).expect("GUI session entropy");
    let token: String = token.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut native_token = [0u8; 24];
    getrandom::fill(&mut native_token).expect("native bridge entropy");
    let native_token: String = native_token.iter().map(|byte| format!("{byte:02x}")).collect();
    let launch_token = token.clone();
    let launch_native_token = native_token.clone();
    tauri::Builder::default()
        // The system file and folder picker (GUI gui/src/picker.ts); the page may only open it, see the capability below.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_booth_login, capture_booth_session])
        .setup(move |app| {
            let resource = app.path().resource_dir()?;
            // Windows reports it as a verbatim path (\\?\C:\...), which Node cannot load a script from.
            #[cfg(windows)]
            let resource = dunce::simplified(&resource).to_path_buf();
            let cli = resource.join("bin").join("avh.js");
            let node = resource.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut command = Command::new(node);
            command
                .arg(cli)
                .args(["gui", "--no-open", "--port", &port.to_string()])
                .env("AVH_GUI_SESSION_TOKEN", &launch_token)
                .env("AVH_GUI_NATIVE_TOKEN", &launch_native_token)
                .env("AVH_BUNDLED_ROOT", resource.join("builtin"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Node is a console program: started from a windowed one, it would get a console window of its own.
            // CREATE_NO_WINDOW gives it a console without a window, which the processes it starts share.
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
            let mut child = command.spawn()?;
            // Each attempt is bounded: on Windows a refused connection to localhost takes about two seconds, and
            // this loop holds the main thread. There is nothing to wait for once the server has exited.
            let address = SocketAddr::from(([127, 0, 0, 1], port));
            for _ in 0..100 {
                if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
                    || matches!(child.try_wait(), Ok(Some(_)))
                {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            app.manage(GuiHost(Mutex::new(Some(child))));
            app.manage(GuiBridge { port, token: launch_native_token.clone() });
            // The Runtime serves the GUI, so Tauri treats it as a remote page and refuses it every command that no
            // capability grants. Only the main window, at exactly this address, may open and read the BOOTH login,
            // and open the system file or folder picker (not the plugin's message or save dialogs).
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("harness-gui")
                    .window("main")
                    .remote(format!("http://127.0.0.1:{port}/*"))
                    .permission("allow-open-booth-login")
                    .permission("allow-capture-booth-session")
                    .permission("dialog:allow-open"),
            )?;
            let url = format!("http://127.0.0.1:{port}/?token={launch_token}").parse()?;
            // The GUI switches to one column at a time in narrow windows, so a small minimum keeps Harness usable on a
            // 1366×768 screen at 150 % scaling.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Harness")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 520.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app
                    .state::<GuiHost>()
                    .0
                    .lock()
                    .expect("GUI host lock")
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
