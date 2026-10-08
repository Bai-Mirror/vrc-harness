//! What Harness needs from Windows that Node cannot reach: named Job Objects that supervise a Run the way a systemd
//! transient unit does on Linux, a restricted Low integrity token for the write boundary, mandatory integrity labels,
//! process command lines, and the per-user autostart entry. The Runtime calls the `avh-win` binary; nothing here keeps
//! state beyond the kernel objects and the files the caller names.
#![cfg(windows)]

pub mod cmdline;
pub mod job;
pub mod label;
pub mod procs;
pub mod registry;
pub mod spawn;
pub mod token;

use std::ffi::OsStr;
use std::fmt;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};

/// A failed Win32 call: what was attempted and the system's error code.
#[derive(Debug)]
pub struct WinError {
    pub code: u32,
    pub context: String,
}

impl WinError {
    pub fn last(context: impl Into<String>) -> Self {
        WinError { code: unsafe { GetLastError() }, context: context.into() }
    }
    pub fn code(code: u32, context: impl Into<String>) -> Self {
        WinError { code, context: context.into() }
    }
    pub fn message(context: impl Into<String>) -> Self {
        WinError { code: 0, context: context.into() }
    }
}

impl fmt::Display for WinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code == 0 {
            write!(f, "{}", self.context)
        } else {
            let text = std::io::Error::from_raw_os_error(self.code as i32);
            write!(f, "{}: {} (Win32 {})", self.context, text, self.code)
        }
    }
}

pub type Result<T> = std::result::Result<T, WinError>;

/// A NUL-terminated UTF-16 copy of a string for Win32.
pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// An owned kernel handle, closed on drop.
pub struct Handle(pub HANDLE);

impl Handle {
    pub fn valid(&self) -> bool {
        !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if self.valid() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// JSON string literal for the small documents the binaries print.
pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Kernel object names Harness uses: letters, digits, `-`, `_` and `.`, under the session's Local namespace.
pub fn object_name(name: &str) -> Result<String> {
    if name.is_empty() || name.len() > 200 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(WinError::message(format!("invalid object name: {name}")));
    }
    Ok(format!("Local\\{name}"))
}
