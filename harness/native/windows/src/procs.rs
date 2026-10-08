//! Processes with their command lines, so the Runtime can tell whether a Unity editor already has a project open.
//! Command lines come from the process itself (ProcessCommandLineInformation), which needs only query access.

use std::ptr::null_mut;

use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, UNICODE_STRING};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::{json_string, Handle, Result, WinError};

pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    pub path: Option<String>,
    pub command_line: Option<String>,
}

impl Process {
    pub fn json(&self) -> String {
        let optional = |value: &Option<String>| value.as_deref().map_or("null".to_string(), json_string);
        format!("{{\"pid\":{},\"parentPid\":{},\"name\":{},\"path\":{},\"commandLine\":{}}}", self.pid, self.parent,
            json_string(&self.name), optional(&self.path), optional(&self.command_line))
    }
}

fn details(pid: u32) -> (Option<String>, Option<String>) {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return (None, None);
    }
    let process = Handle(raw);
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let path = if unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size) } != 0 {
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    } else {
        None
    };
    let mut needed = 0u32;
    unsafe { NtQueryInformationProcess(process.0, ProcessCommandLineInformation, null_mut(), 0, &mut needed) };
    let command_line = if needed > 0 {
        let mut data = vec![0u8; needed as usize + 16];
        let status = unsafe {
            NtQueryInformationProcess(process.0, ProcessCommandLineInformation, data.as_mut_ptr() as *mut _,
                data.len() as u32, &mut needed)
        };
        if status >= 0 {
            let text = unsafe { &*(data.as_ptr() as *const UNICODE_STRING) };
            let chars = unsafe { std::slice::from_raw_parts(text.Buffer, (text.Length / 2) as usize) };
            Some(String::from_utf16_lossy(chars))
        } else {
            None
        }
    } else {
        None
    };
    (path, command_line)
}

/// Every process, or those whose image name matches `name` (case-insensitive).
pub fn list(name: Option<&str>) -> Result<Vec<Process>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(WinError::last("CreateToolhelp32Snapshot"));
    }
    let snapshot = Handle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while ok != 0 {
        let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        let exe = String::from_utf16_lossy(&entry.szExeFile[..length]);
        if name.map_or(true, |wanted| wanted.eq_ignore_ascii_case(&exe)) {
            let (path, command_line) = details(entry.th32ProcessID);
            found.push(Process { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, name: exe, path, command_line });
        }
        ok = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(found)
}
