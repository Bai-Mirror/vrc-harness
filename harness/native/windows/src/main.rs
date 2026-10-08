//! avh-win: the Runtime's Windows helper. Every subcommand prints one JSON document on stdout (except `sandbox`,
//! whose stdout belongs to the program it runs) and reports failures on stderr with a non-zero exit code.
//!
//!   unit     --name N --run-dir D [--memory-max BYTES] [--runtime-max-sec S] -- ARGV   supervise a Run (like systemd-run)
//!   query    --name N                                                                  running | empty | not_found
//!   stop     --name N [--exit-code C] [--wait-ms MS]                                   terminate the whole job
//!   sandbox  [--low] [--name N] [--memory-max BYTES] [--cwd D] -- ARGV                run ARGV in its own job
//!   label    (--low|--medium|--private|--clear|--get) PATH ...                         integrity labels
//!   procs    [--name IMAGE.exe]                                                        processes and command lines
//!   autostart (--set NAME -- ARGV | --get NAME | --remove NAME)                        HKCU Run entry
//!   version

#[cfg(not(windows))]
fn main() {
    eprintln!("avh-win only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_main::run());
}

#[cfg(windows)]
mod windows_main {
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use avh_win::job::{self, Breakaway, Created, Job};
    use avh_win::{json_string, label, procs, registry, spawn, token, Result, WinError};
    use windows_sys::Win32::System::Console::GetConsoleWindow;
    /// winnt.h: the last process in a job has exited (windows-sys keeps it in SystemServices).
    const JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO: u32 = 4;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, TerminateProcess, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, INFINITE,
    };

    pub const VERSION: &str = env!("CARGO_PKG_VERSION");
    /// Bumped when a subcommand's arguments or output change; the Runtime refuses a helper it does not speak.
    pub const PROTOCOL: u32 = 1;

    struct Args {
        options: Vec<(String, OsString)>,
        flags: Vec<String>,
        argv: Vec<OsString>,
    }

    impl Args {
        fn value(&self, name: &str) -> Option<&OsString> {
            self.options.iter().find(|(key, _)| key == name).map(|(_, value)| value)
        }
        fn text(&self, name: &str) -> Option<String> {
            self.value(name).map(|value| value.to_string_lossy().into_owned())
        }
        fn number(&self, name: &str) -> Result<Option<u64>> {
            match self.text(name) {
                None => Ok(None),
                Some(text) => text.parse::<u64>().map(Some)
                    .map_err(|_| WinError::message(format!("{name}: not a number: {text}"))),
            }
        }
        fn flag(&self, name: &str) -> bool {
            self.flags.iter().any(|flag| flag == name)
        }
    }

    /// `--key value` pairs and bare flags up to `--`; everything after `--` is the command to run.
    fn parse(raw: &[OsString], valued: &[&str]) -> Result<Args> {
        let mut args = Args { options: Vec::new(), flags: Vec::new(), argv: Vec::new() };
        let mut i = 0;
        while i < raw.len() {
            let item = raw[i].to_string_lossy().into_owned();
            if item == "--" {
                args.argv = raw[i + 1..].to_vec();
                break;
            }
            if valued.contains(&item.as_str()) {
                let value = raw.get(i + 1).ok_or_else(|| WinError::message(format!("{item}: missing value")))?;
                args.options.push((item, value.clone()));
                i += 2;
            } else if item.starts_with("--") {
                args.flags.push(item);
                i += 1;
            } else {
                return Err(WinError::message(format!("unexpected argument: {item}")));
            }
        }
        Ok(args)
    }

    fn fail(error: WinError, code: i32) -> i32 {
        eprintln!("avh-win: {error}");
        code
    }

    /// A child of a helper without a console window must not get one of its own: CREATE_NO_WINDOW gives it a console
    /// with no window, which its own console children then share.
    fn window_flags() -> u32 {
        if unsafe { GetConsoleWindow() }.is_null() { CREATE_NO_WINDOW } else { 0 }
    }

    fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, content)?;
        fs::rename(&temporary, path)
    }

    pub fn run() -> i32 {
        let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
        let Some(command) = raw.first().map(|c| c.to_string_lossy().into_owned()) else {
            return fail(WinError::message("usage: avh-win unit|query|stop|sandbox|label|procs|autostart|version"), 2);
        };
        let rest = &raw[1..];
        let outcome = match command.as_str() {
            "version" => { println!("{{\"version\":{},\"protocol\":{PROTOCOL}}}", json_string(VERSION)); Ok(0) }
            "unit" => parse(rest, &["--name", "--run-dir", "--memory-max", "--runtime-max-sec"]).and_then(|args| unit(&args, rest)),
            "query" => parse(rest, &["--name"]).and_then(|args| query(&args)),
            "stop" => parse(rest, &["--name", "--exit-code", "--wait-ms"]).and_then(|args| stop(&args)),
            "sandbox" => parse(rest, &["--name", "--memory-max", "--cwd"]).and_then(|args| sandbox(&args)),
            "label" => labels(rest),
            "procs" => parse(rest, &["--name"]).and_then(|args| {
                let list = procs::list(args.text("--name").as_deref())?;
                println!("[{}]", list.iter().map(|process| process.json()).collect::<Vec<_>>().join(","));
                Ok(0)
            }),
            "autostart" => parse(rest, &["--set", "--get", "--remove"]).and_then(|args| autostart(&args)),
            other => Err(WinError::message(format!("unknown command: {other}"))),
        };
        outcome.unwrap_or_else(|error| fail(error, 1))
    }

    /// Supervise one Run: a named job holds the command and everything it starts; this process keeps the job (and so
    /// its name) alive until the last process in it has exited, then exits itself. Killing this process kills the Run.
    fn unit(args: &Args, raw: &[OsString]) -> Result<i32> {
        let name = args.text("--name").ok_or_else(|| WinError::message("--name is required"))?;
        let run_dir = PathBuf::from(args.value("--run-dir").ok_or_else(|| WinError::message("--run-dir is required"))?);
        if args.argv.is_empty() {
            return Err(WinError::message("no command after --"));
        }
        let log = run_dir.join("unit-helper.log");
        let report = |error: WinError| -> i32 {
            let _ = fs::write(&log, format!("{error}\n"));
            fail(error, 1)
        };
        // A Run must outlive whoever launched it (a scheduler restart must not stop it), so leave any job we were
        // started in when that job allows it; the copy started outside takes over.
        if !args.flag("--no-breakaway") {
            if let Breakaway::Allowed { silent } = job::current_breakaway() {
                let exe = std::env::current_exe().map_err(|error| WinError::message(format!("current_exe: {error}")))?;
                let mut argv: Vec<OsString> = vec![exe.into_os_string(), "unit".into(), "--no-breakaway".into()];
                argv.extend_from_slice(raw);
                let flags = window_flags() | if silent { 0 } else { CREATE_BREAKAWAY_FROM_JOB };
                let child = match spawn::suspended(&argv, None, None, flags) { Ok(child) => child, Err(error) => return Ok(report(error)) };
                child.resume()?;
                // Return only once the job is visible, or with the copy's own exit code if it ended first.
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline {
                    if Job::open(&name, false)?.is_some() {
                        return Ok(0);
                    }
                    if unsafe { WaitForSingleObject(child.process.0, 50) } == 0 {
                        let mut code = 1u32;
                        unsafe { GetExitCodeProcess(child.process.0, &mut code) };
                        return Ok(code as i32);
                    }
                }
                return Ok(report(WinError::message("the relaunched supervisor did not create its job")));
            }
        }
        let memory = args.number("--memory-max")?.map(|bytes| bytes as usize);
        let mut job = match Job::create(Some(&name), memory) {
            Ok(Created::New(job)) => job,
            Ok(Created::Exists) => { println!("{{\"state\":\"exists\"}}"); return Ok(17); }
            Err(error) => return Ok(report(error)),
        };
        if let Err(error) = job.watch() {
            return Ok(report(error));
        }
        let child = match spawn::suspended(&args.argv, Some(&run_dir), None, window_flags()) {
            Ok(child) => child,
            Err(error) => return Ok(report(error)),
        };
        if let Err(error) = job.assign(child.process.0) {
            unsafe { TerminateProcess(child.process.0, 1) };
            return Ok(report(error));
        }
        child.resume()?;
        let _ = fs::write(run_dir.join("unit-helper.json"), format!("{{\"pid\":{},\"childPid\":{},\"name\":{}}}",
            std::process::id(), child.pid, json_string(&name)));
        drop(child);
        let deadline = args.number("--runtime-max-sec")?.map(|seconds| Instant::now() + Duration::from_secs(seconds));
        let mut timed_out = false;
        loop {
            let wait = match deadline {
                Some(at) if !timed_out => at.saturating_duration_since(Instant::now()).as_millis().min(1000) as u32,
                _ => 1000,
            };
            if job.next_message(wait) == Some(JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) || job.active_processes()? == 0 {
                break;
            }
            if let Some(at) = deadline {
                if !timed_out && Instant::now() >= at {
                    timed_out = true;
                    job.terminate(124)?;
                }
            }
        }
        let exit = run_dir.join("exit.json");
        if timed_out && !exit.exists() {
            let _ = write_atomic(&exit,
                "{\"exitStatus\":124,\"timedOut\":true,\"exit\":{\"code\":124,\"timedOut\":true,\"cancelled\":false}}");
        }
        Ok(0)
    }

    fn query(args: &Args) -> Result<i32> {
        let name = args.text("--name").ok_or_else(|| WinError::message("--name is required"))?;
        match Job::open(&name, false)? {
            None => println!("{{\"state\":\"not_found\"}}"),
            Some(job) => {
                let active = job.active_processes()?;
                if active > 0 { println!("{{\"state\":\"running\",\"active\":{active}}}") } else { println!("{{\"state\":\"empty\"}}") }
            }
        }
        Ok(0)
    }

    fn stop(args: &Args) -> Result<i32> {
        let name = args.text("--name").ok_or_else(|| WinError::message("--name is required"))?;
        let code = args.number("--exit-code")?.unwrap_or(143) as u32;
        let wait = Duration::from_millis(args.number("--wait-ms")?.unwrap_or(15_000));
        let Some(job) = Job::open(&name, true)? else {
            println!("{{\"state\":\"not_found\"}}");
            return Ok(0);
        };
        job.close_to_new_processes()?;
        job.terminate(code)?;
        let deadline = Instant::now() + wait;
        loop {
            let active = job.active_processes()?;
            if active == 0 {
                println!("{{\"state\":\"stopped\"}}");
                return Ok(0);
            }
            if Instant::now() >= deadline {
                println!("{{\"state\":\"timeout\",\"active\":{active}}}");
                return Ok(0);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Run ARGV in a job of its own (nested in any job we are in) that dies with this process, optionally under the
    /// restricted Low token. Returns ARGV's exit code; whatever it left running is terminated with it.
    fn sandbox(args: &Args) -> Result<i32> {
        if args.argv.is_empty() {
            return Err(WinError::message("no command after --"));
        }
        let memory = args.number("--memory-max")?.map(|bytes| bytes as usize);
        let job = match Job::create(args.text("--name").as_deref(), memory)? {
            Created::New(job) => job,
            Created::Exists => return Ok(fail(WinError::message("a sandbox with this name is already running"), 17)),
        };
        let token = if args.flag("--low") { Some(token::low_restricted()?) } else { None };
        let cwd = args.value("--cwd").map(PathBuf::from);
        let child = match spawn::suspended(&args.argv, cwd.as_deref(), token.as_ref(), window_flags()) {
            Ok(child) => child,
            Err(error) => return Ok(fail(error, 127)),
        };
        if let Err(error) = job.assign(child.process.0) {
            unsafe { TerminateProcess(child.process.0, 126) };
            return Ok(fail(error, 126));
        }
        child.resume()?;
        unsafe { WaitForSingleObject(child.process.0, INFINITE) };
        let mut code = 1u32;
        unsafe { GetExitCodeProcess(child.process.0, &mut code) };
        let _ = job.terminate(code);
        Ok(code as i32)
    }

    fn labels(raw: &[OsString]) -> Result<i32> {
        let mut results = Vec::new();
        let mut failed = false;
        let mut i = 0;
        while i < raw.len() {
            let flag = raw[i].to_string_lossy().into_owned();
            let path = PathBuf::from(raw.get(i + 1).ok_or_else(|| WinError::message(format!("{flag}: missing path")))?);
            i += 2;
            let shown = json_string(&path.to_string_lossy());
            if flag == "--get" {
                match label::describe(&path) {
                    Ok(sddl) => results.push(format!("{{\"path\":{shown},\"label\":{}}}", json_string(&sddl))),
                    Err(error) => { failed = true; results.push(format!("{{\"path\":{shown},\"error\":{}}}", json_string(&error.to_string()))) }
                }
                continue;
            }
            let kind = label::Kind::parse(&flag).ok_or_else(|| WinError::message(format!("unknown label flag: {flag}")))?;
            match label::apply(&path, kind) {
                Ok(()) => results.push(format!("{{\"path\":{shown},\"ok\":true}}")),
                Err(error) => { failed = true; results.push(format!("{{\"path\":{shown},\"ok\":false,\"error\":{}}}", json_string(&error.to_string()))) }
            }
        }
        println!("[{}]", results.join(","));
        Ok(if failed { 1 } else { 0 })
    }

    fn autostart(args: &Args) -> Result<i32> {
        if let Some(name) = args.text("--set") {
            if args.argv.is_empty() {
                return Err(WinError::message("no command after --"));
            }
            let line = registry::set(&name, &args.argv)?;
            println!("{{\"value\":{}}}", json_string(&line));
        } else if let Some(name) = args.text("--get") {
            match registry::get(&name)? {
                Some(line) => println!("{{\"value\":{}}}", json_string(&line)),
                None => println!("{{\"value\":null}}"),
            }
        } else if let Some(name) = args.text("--remove") {
            println!("{{\"removed\":{}}}", registry::remove(&name)?);
        } else {
            return Err(WinError::message("autostart needs --set, --get or --remove"));
        }
        Ok(0)
    }
}
