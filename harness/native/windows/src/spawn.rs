//! Starting a process suspended, so it joins its job before it runs a single instruction, and handing it exactly our
//! three standard handles: PROC_THREAD_ATTRIBUTE_HANDLE_LIST keeps every other inheritable handle (a job, a token, a
//! stray pipe) out of the child.

use std::ffi::OsString;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    ResumeThread, UpdateProcThreadAttribute, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::cmdline::{command_line, resolve_program};
use crate::{wide, Handle, Result, WinError};

pub struct Child {
    pub process: Handle,
    pub thread: Handle,
    pub pid: u32,
}

impl Child {
    pub fn resume(&self) -> Result<()> {
        if unsafe { ResumeThread(self.thread.0) } == u32::MAX {
            return Err(WinError::last("ResumeThread"));
        }
        Ok(())
    }
}

fn usable(handle: HANDLE) -> bool {
    !handle.is_null() && handle != INVALID_HANDLE_VALUE
}

/// Start `argv` suspended with our standard handles, under `token` when given (CreateProcessAsUser accepts a
/// restricted copy of the caller's own token without any privilege). The environment is inherited.
pub fn suspended(argv: &[OsString], cwd: Option<&Path>, token: Option<&Handle>, extra_flags: u32) -> Result<Child> {
    let first = argv.first().ok_or_else(|| WinError::message("empty command"))?;
    let program = resolve_program(first)?;
    let application = wide(program.as_os_str());
    let mut line = command_line(argv);
    let cwd_wide = cwd.map(|dir| wide(dir.as_os_str()));

    let std = unsafe { [GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)] };
    let mut inherit: Vec<HANDLE> = Vec::new();
    for &handle in &std {
        if usable(handle) && !inherit.contains(&handle) {
            // Console handles may not be inheritable yet; the child needs them to be.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
            inherit.push(handle);
        }
    }

    let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.StartupInfo.hStdInput = if usable(std[0]) { std[0] } else { null_mut() };
    info.StartupInfo.hStdOutput = if usable(std[1]) { std[1] } else { null_mut() };
    info.StartupInfo.hStdError = if usable(std[2]) { std[2] } else { null_mut() };

    let mut attributes: Vec<u8> = Vec::new();
    let mut flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | extra_flags;
    if !inherit.is_empty() {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        attributes.resize(size, 0);
        let list = attributes.as_mut_ptr() as *mut core::ffi::c_void;
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return Err(WinError::last("InitializeProcThreadAttributeList"));
        }
        if unsafe {
            UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, inherit.as_ptr() as *const _,
                inherit.len() * std::mem::size_of::<HANDLE>(), null_mut(), null())
        } == 0 {
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(WinError::last("UpdateProcThreadAttribute(handle list)"));
        }
        info.lpAttributeList = list;
        flags |= EXTENDED_STARTUPINFO_PRESENT;
    }

    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let inherit_handles = if inherit.is_empty() { 0 } else { 1 };
    let cwd_ptr = cwd_wide.as_ref().map_or(null(), |w| w.as_ptr());
    let ok = unsafe {
        match token {
            Some(token) => CreateProcessAsUserW(token.0, application.as_ptr(), line.as_mut_ptr(), null(), null(),
                inherit_handles, flags, null(), cwd_ptr, &info.StartupInfo, &mut process),
            None => CreateProcessW(application.as_ptr(), line.as_mut_ptr(), null(), null(), inherit_handles, flags,
                null(), cwd_ptr, &info.StartupInfo, &mut process),
        }
    };
    let error = if ok == 0 { Some(WinError::last(format!("CreateProcess {}", program.display()))) } else { None };
    if !attributes.is_empty() {
        unsafe { DeleteProcThreadAttributeList(info.lpAttributeList) };
    }
    if let Some(error) = error {
        return Err(error);
    }
    Ok(Child { process: Handle(process.hProcess), thread: Handle(process.hThread), pid: process.dwProcessId })
}
