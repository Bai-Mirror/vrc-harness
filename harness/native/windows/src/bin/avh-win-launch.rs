//! avh-win-launch: start a program detached and without any window, then exit. Windows runs HKCU\...\Run entries
//! through Explorer, which would give a console program (node) a visible console; this GUI-subsystem launcher does not.
//!
//!   avh-win-launch [--log FILE] [--cwd DIR] [--env NAME=VALUE]... -- ARGV
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("avh-win-launch only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsString;
    use std::fs::OpenOptions;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut log = None;
    let mut cwd = None;
    let mut env: Vec<(String, String)> = Vec::new();
    let mut argv: Vec<OsString> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let item = raw[i].to_string_lossy().into_owned();
        match item.as_str() {
            "--" => { argv = raw[i + 1..].to_vec(); break; }
            "--log" | "--cwd" | "--env" => {
                let Some(value) = raw.get(i + 1) else { std::process::exit(2) };
                match item.as_str() {
                    "--log" => log = Some(value.clone()),
                    "--cwd" => cwd = Some(value.clone()),
                    _ => {
                        let text = value.to_string_lossy();
                        let Some((name, value)) = text.split_once('=') else { std::process::exit(2) };
                        env.push((name.to_string(), value.to_string()));
                    }
                }
                i += 2;
            }
            _ => std::process::exit(2),
        }
    }
    if argv.is_empty() {
        std::process::exit(2);
    }
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).stdin(Stdio::null());
    for (name, value) in env {
        command.env(name, value);
    }
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    match log.and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok()) {
        Some(file) => {
            let err = file.try_clone().map(Stdio::from).unwrap_or_else(|_| Stdio::null());
            command.stdout(Stdio::from(file)).stderr(err);
        }
        None => { command.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
    // CREATE_NO_WINDOW gives the program a console without a window, which every console program it starts shares:
    // no window ever appears. (DETACHED_PROCESS would leave it with no console at all, and each console child it
    // starts would then open a window of its own; Windows ignores CREATE_NO_WINDOW when both are given.)
    let flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    // Leave a job we were started in when it allows it, so the service outlives the session's job; otherwise start anyway.
    let started = command.creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB).spawn()
        .or_else(|_| command.creation_flags(flags).spawn());
    std::process::exit(if started.is_ok() { 0 } else { 1 });
}
