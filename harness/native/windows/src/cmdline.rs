//! Turning an argv into the single command line CreateProcess takes, and finding the program without the current
//! directory: a Run directory is writable by the Run, so a program planted there must never be picked up.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::{Result, WinError};

/// Quote one argument so that the Microsoft C runtime's parser (CommandLineToArgvW rules) gives it back unchanged.
pub fn quote(arg: &OsStr, out: &mut Vec<u16>) {
    use std::os::windows::ffi::OsStrExt;
    let chars: Vec<u16> = arg.encode_wide().collect();
    let needs = chars.is_empty() || chars.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'\n' as u16
        || c == 0x0b || c == b'"' as u16);
    if !needs {
        out.extend_from_slice(&chars);
        return;
    }
    out.push(b'"' as u16);
    let mut i = 0;
    loop {
        let mut backslashes = 0;
        while i < chars.len() && chars[i] == b'\\' as u16 {
            i += 1;
            backslashes += 1;
        }
        if i == chars.len() {
            // Backslashes before the closing quote are doubled so the quote stays a delimiter.
            out.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2));
            break;
        } else if chars[i] == b'"' as u16 {
            out.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2 + 1));
            out.push(b'"' as u16);
        } else {
            out.extend(std::iter::repeat(b'\\' as u16).take(backslashes));
            out.push(chars[i]);
        }
        i += 1;
    }
    out.push(b'"' as u16);
}

/// The NUL-terminated, mutable command line CreateProcess expects.
pub fn command_line(argv: &[OsString]) -> Vec<u16> {
    let mut out = Vec::new();
    for (index, arg) in argv.iter().enumerate() {
        if index > 0 {
            out.push(b' ' as u16);
        }
        quote(arg, &mut out);
    }
    out.push(0);
    out
}

fn is_batch(path: &Path) -> bool {
    path.extension().map(|ext| {
        let ext = ext.to_string_lossy().to_ascii_lowercase();
        ext == "cmd" || ext == "bat"
    }).unwrap_or(false)
}

/// The executable argv[0] names: a path as given, or a bare name looked up on PATH with `.exe` and `.com`.
/// Batch files are refused: CreateProcess would hand them to cmd.exe, whose own parsing the quoting above cannot match.
pub fn resolve_program(name: &OsStr) -> Result<PathBuf> {
    let given = Path::new(name);
    let explicit = given.is_absolute() || name.to_string_lossy().contains(['\\', '/']);
    let candidates = |base: &Path| -> Vec<PathBuf> {
        let mut list = vec![base.to_path_buf()];
        if base.extension().is_none() {
            for ext in ["exe", "com"] {
                list.push(base.with_extension(ext));
            }
        }
        list
    };
    let found = if explicit {
        candidates(given).into_iter().find(|path| path.is_file())
    } else {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path).filter(|dir| dir.is_absolute())
                .flat_map(|dir| candidates(&dir.join(given))).find(|path| path.is_file())
        })
    };
    let program = found.ok_or_else(|| WinError::code(2, format!("program not found: {}", name.to_string_lossy())))?;
    if is_batch(&program) {
        return Err(WinError::message(format!("batch files cannot be started directly: {}", program.display())));
    }
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(args: &[&str]) -> String {
        let argv: Vec<OsString> = args.iter().map(OsString::from).collect();
        let wide = command_line(&argv);
        String::from_utf16(&wide[..wide.len() - 1]).unwrap()
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(line(&["a", "b c", ""]), "a \"b c\" \"\"");
    }

    #[test]
    fn escapes_quotes_and_trailing_backslashes() {
        assert_eq!(line(&["say \"hi\""]), "\"say \\\"hi\\\"\"");
        assert_eq!(line(&["C:\\dir with space\\"]), "\"C:\\dir with space\\\\\"");
        assert_eq!(line(&["a\\\\b"]), "a\\\\b");
    }
}
