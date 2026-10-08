//! The per-user login autostart entry (HKCU\...\Run). Low processes cannot write HKCU outside AppDataLow, so a
//! sandboxed Run cannot plant or change it.

use std::ffi::OsString;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

use crate::cmdline::command_line;
use crate::{wide, Result, WinError};

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

fn valid(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 100 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(WinError::message(format!("invalid autostart name: {name}")));
    }
    Ok(())
}

pub fn set(name: &str, argv: &[OsString]) -> Result<String> {
    valid(name)?;
    let line = command_line(argv);
    let status = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, wide(RUN_KEY).as_ptr(), wide(name).as_ptr(), REG_SZ, line.as_ptr() as *const _,
            (line.len() * 2) as u32)
    };
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, "RegSetKeyValue"));
    }
    Ok(String::from_utf16_lossy(&line[..line.len() - 1]))
}

pub fn get(name: &str) -> Result<Option<String>> {
    valid(name)?;
    let mut size = 0u32;
    let key = wide(RUN_KEY);
    let value = wide(name);
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut size)
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, "RegGetValue"));
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2) + 1];
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, null_mut(), data.as_mut_ptr() as *mut _,
            &mut size)
    };
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, "RegGetValue"));
    }
    let length = data.iter().position(|&c| c == 0).unwrap_or(data.len());
    Ok(Some(String::from_utf16_lossy(&data[..length])))
}

pub fn remove(name: &str) -> Result<bool> {
    valid(name)?;
    let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(RUN_KEY).as_ptr(), wide(name).as_ptr()) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, "RegDeleteKeyValue"));
    }
    Ok(true)
}
