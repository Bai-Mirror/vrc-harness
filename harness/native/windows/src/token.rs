//! The token a sandboxed Run gets: the caller's own token with every privilege but traversal removed, the
//! Administrators group made deny-only, and the Low mandatory integrity level. A Low process cannot open for writing
//! anything labelled higher (every ordinary file, registry key, named pipe and process of the user is Medium), so it
//! writes only where Harness put a Low label. Creating it needs no privilege: it is a restricted copy of our own token.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, GetLengthSid, SetTokenInformation, TokenIntegrityLevel, DISABLE_MAX_PRIVILEGE, PSID,
    SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::{wide, Handle, Result, WinError};

pub const LOW_INTEGRITY_SID: &str = "S-1-16-4096";
const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
/// winnt.h SE_GROUP_INTEGRITY (windows-sys keeps it in the SystemServices module).
const SE_GROUP_INTEGRITY: u32 = 0x20;

struct Sid(PSID);
impl Sid {
    fn parse(text: &str) -> Result<Sid> {
        let mut sid: PSID = null_mut();
        if unsafe { ConvertStringSidToSidW(wide(text).as_ptr(), &mut sid) } == 0 {
            return Err(WinError::last(format!("ConvertStringSidToSid {text}")));
        }
        Ok(Sid(sid))
    }
}
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

/// A primary token for CreateProcessAsUser: restricted and at Low integrity.
pub fn low_restricted() -> Result<Handle> {
    let mut own: HANDLE = null_mut();
    if unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut own)
    } == 0 {
        return Err(WinError::last("OpenProcessToken"));
    }
    let own = Handle(own);
    let admins = Sid::parse(ADMINISTRATORS_SID)?;
    let disable = [SID_AND_ATTRIBUTES { Sid: admins.0, Attributes: 0 }];
    let mut restricted: HANDLE = null_mut();
    if unsafe {
        CreateRestrictedToken(own.0, DISABLE_MAX_PRIVILEGE, disable.len() as u32, disable.as_ptr(), 0, null(), 0, null(),
            &mut restricted)
    } == 0 {
        return Err(WinError::last("CreateRestrictedToken"));
    }
    let restricted = Handle(restricted);
    let low = Sid::parse(LOW_INTEGRITY_SID)?;
    let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: low.0, Attributes: SE_GROUP_INTEGRITY } };
    let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + unsafe { GetLengthSid(low.0) };
    if unsafe { SetTokenInformation(restricted.0, TokenIntegrityLevel, &label as *const _ as *const _, size) } == 0 {
        return Err(WinError::last("SetTokenInformation(TokenIntegrityLevel)"));
    }
    Ok(restricted)
}
