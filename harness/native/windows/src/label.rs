//! Mandatory integrity labels on files and directories. A Low label makes a path writable by a Low process; an explicit
//! Medium label keeps it read-only inside a Low tree (a repository's .git); Medium with no-read-up hides it from Low
//! processes entirely (the Runtime's configuration, state and control files). Labelling an object you own at or below
//! your own integrity level needs no privilege. SetNamedSecurityInfo carries an inheritable label down to the
//! existing children as well as to everything created later.

use std::path::Path;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorSacl, InitializeAcl, ACL, ACL_REVISION, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
};

use crate::{wide, Result, WinError};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// Writable by Low processes.
    Low,
    /// Readable but not writable by Low processes, even inside a Low tree.
    Medium,
    /// Neither readable nor writable by Low processes.
    Private,
    /// No explicit label: inherit from the parent again.
    Clear,
}

impl Kind {
    pub fn parse(flag: &str) -> Option<Kind> {
        match flag {
            "--low" => Some(Kind::Low),
            "--medium" => Some(Kind::Medium),
            "--private" => Some(Kind::Private),
            "--clear" => Some(Kind::Clear),
            _ => None,
        }
    }
    fn sddl(self, directory: bool) -> &'static str {
        match (self, directory) {
            (Kind::Low, true) => "S:(ML;OICI;NW;;;LW)",
            (Kind::Low, false) => "S:(ML;;NW;;;LW)",
            (Kind::Medium, true) => "S:(ML;OICI;NW;;;ME)",
            (Kind::Medium, false) => "S:(ML;;NW;;;ME)",
            (Kind::Private, true) => "S:(ML;OICI;NRNW;;;ME)",
            (Kind::Private, false) => "S:(ML;;NRNW;;;ME)",
            (Kind::Clear, _) => "S:",
        }
    }
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

pub fn apply(path: &Path, kind: Kind) -> Result<()> {
    let directory = path.is_dir();
    if !directory && !path.exists() {
        return Err(WinError::code(2, format!("label {}", path.display())));
    }
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(kind.sddl(directory)).as_ptr(), SDDL_REVISION_1,
            &mut descriptor, null_mut())
    } == 0 {
        return Err(WinError::last("ConvertStringSecurityDescriptorToSecurityDescriptor"));
    }
    let descriptor = Descriptor(descriptor);
    let mut present = 0;
    let mut defaulted = 0;
    let mut sacl: *mut ACL = null_mut();
    if unsafe { GetSecurityDescriptorSacl(descriptor.0, &mut present, &mut sacl, &mut defaulted) } == 0 {
        return Err(WinError::last("GetSecurityDescriptorSacl"));
    }
    // Clearing passes an empty ACL: the explicit label goes and the parent's inheritable one applies again. Touching
    // the SACL's protection instead would need SeSecurityPrivilege, which a normal user does not hold.
    let mut empty: ACL = unsafe { std::mem::zeroed() };
    if kind == Kind::Clear {
        if unsafe { InitializeAcl(&mut empty, std::mem::size_of::<ACL>() as u32, ACL_REVISION) } == 0 {
            return Err(WinError::last("InitializeAcl"));
        }
        sacl = &mut empty;
    }
    let status = unsafe {
        SetNamedSecurityInfoW(wide(path.as_os_str()).as_ptr(), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null_mut(),
            null_mut(), null_mut(), sacl)
    };
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, format!("SetNamedSecurityInfo {}", path.display())));
    }
    Ok(())
}

/// The label part of the path's security descriptor in SDDL, e.g. `S:(ML;OICI;NW;;;LW)`; empty when unlabelled.
pub fn describe(path: &Path) -> Result<String> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(wide(path.as_os_str()).as_ptr(), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null_mut(),
            null_mut(), null_mut(), null_mut(), &mut descriptor)
    };
    if status != ERROR_SUCCESS {
        return Err(WinError::code(status, format!("GetNamedSecurityInfo {}", path.display())));
    }
    let descriptor = Descriptor(descriptor);
    let mut text: *mut u16 = null_mut();
    let mut length = 0u32;
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor.0, SDDL_REVISION_1, LABEL_SECURITY_INFORMATION,
            &mut text, &mut length)
    } == 0 {
        return Err(WinError::last("ConvertSecurityDescriptorToStringSecurityDescriptor"));
    }
    let slice = unsafe { std::slice::from_raw_parts(text, length as usize) };
    let value = String::from_utf16_lossy(slice).trim_end_matches('\0').to_string();
    unsafe { LocalFree(text as *mut _) };
    Ok(value)
}
