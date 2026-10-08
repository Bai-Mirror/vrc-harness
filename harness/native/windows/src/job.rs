//! Job Objects: the Windows counterpart of a systemd unit's cgroup. Every process a Run starts stays in its job
//! (Harness never allows breakaway), so "the job has no active process" is "the cgroup is empty", and terminating the
//! job stops the whole tree at once. A named job is findable only while some handle to it is open; the `unit`
//! supervisor holds that handle for the Run's lifetime.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED};

use crate::{object_name, wide, Handle, Result, WinError};

// winnt.h job access rights (windows-sys keeps them in the much larger SystemServices module).
const JOB_OBJECT_QUERY: u32 = 0x0004;
const JOB_OBJECT_TERMINATE: u32 = 0x0008;
const JOB_OBJECT_SET_ATTRIBUTES: u32 = 0x0002;

pub struct Job {
    pub handle: Handle,
    port: Option<Handle>,
}

pub enum Created {
    New(Job),
    /// Another process already holds a job with this name: the Run was launched before.
    Exists,
}

impl Job {
    /// A job whose processes all die when the last handle to it closes (like bwrap's --die-with-parent), with an
    /// optional memory ceiling for the whole tree. `name` is None for an anonymous job.
    pub fn create(name: Option<&str>, job_memory: Option<usize>) -> Result<Created> {
        let full = name.map(object_name).transpose()?;
        let wide_name = full.as_ref().map(wide);
        let raw = unsafe { CreateJobObjectW(null(), wide_name.as_ref().map_or(null(), |w| w.as_ptr())) };
        if raw.is_null() {
            return Err(WinError::last(format!("CreateJobObject {}", full.unwrap_or_default())));
        }
        let handle = Handle(raw);
        if name.is_some() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Ok(Created::Exists);
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if let Some(bytes) = job_memory {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = bytes;
        }
        if unsafe {
            SetInformationJobObject(handle.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        } == 0 {
            return Err(WinError::last("SetInformationJobObject(limits)"));
        }
        Ok(Created::New(Job { handle, port: None }))
    }

    /// The named job, or None when no process holds it open (never launched, or finished and gone).
    pub fn open(name: &str, terminate: bool) -> Result<Option<Job>> {
        let full = object_name(name)?;
        let access = JOB_OBJECT_QUERY | if terminate { JOB_OBJECT_TERMINATE | JOB_OBJECT_SET_ATTRIBUTES } else { 0 };
        let raw = unsafe { OpenJobObjectW(access, 0, wide(&full).as_ptr()) };
        if raw.is_null() {
            let code = unsafe { GetLastError() };
            if code == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            return Err(WinError::code(code, format!("OpenJobObject {full}")));
        }
        Ok(Some(Job { handle: Handle(raw), port: None }))
    }

    /// Completion messages must be requested before the first process joins, or its exit could be missed.
    pub fn watch(&mut self) -> Result<()> {
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        if port.is_null() {
            return Err(WinError::last("CreateIoCompletionPort"));
        }
        let port = Handle(port);
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: self.handle.0, CompletionPort: port.0 };
        if unsafe {
            SetInformationJobObject(self.handle.0, JobObjectAssociateCompletionPortInformation,
                &association as *const _ as *const _, std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32)
        } == 0 {
            return Err(WinError::last("SetInformationJobObject(completion port)"));
        }
        self.port = Some(port);
        Ok(())
    }

    /// The next job message within `timeout_ms`: Some(message id), or None on timeout.
    pub fn next_message(&self, timeout_ms: u32) -> Option<u32> {
        let port = self.port.as_ref()?;
        let mut message = 0u32;
        let mut key = 0usize;
        let mut overlapped: *mut OVERLAPPED = null_mut();
        let ok = unsafe { GetQueuedCompletionStatus(port.0, &mut message, &mut key, &mut overlapped, timeout_ms) };
        if ok == 0 { None } else { Some(message) }
    }

    pub fn assign(&self, process: HANDLE) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.handle.0, process) } == 0 {
            return Err(WinError::last("AssignProcessToJobObject"));
        }
        Ok(())
    }

    pub fn active_processes(&self) -> Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(self.handle.0, JobObjectBasicAccountingInformation, &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut())
        } == 0 {
            return Err(WinError::last("QueryInformationJobObject(accounting)"));
        }
        Ok(info.ActiveProcesses)
    }

    /// No process may join the job any more, nor start inside it: the kernel refuses every later assignment and every
    /// CreateProcess from within it. A stop does this first, so a supervisor that created the job but has not yet put
    /// its command in cannot start that command after the stop.
    pub fn close_to_new_processes(&self) -> Result<()> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(self.handle.0, JobObjectExtendedLimitInformation, &mut limits as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32, null_mut())
        } == 0 {
            return Err(WinError::last("QueryInformationJobObject(limits)"));
        }
        limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 0;
        if unsafe {
            SetInformationJobObject(self.handle.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        } == 0 {
            return Err(WinError::last("SetInformationJobObject(active process limit)"));
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        if unsafe { TerminateJobObject(self.handle.0, exit_code) } == 0 {
            return Err(WinError::last("TerminateJobObject"));
        }
        Ok(())
    }
}

/// Whether this process may leave the job it runs in, if any: None when it is in no job.
pub enum Breakaway { NotInJob, Allowed { silent: bool }, Denied }

pub fn current_breakaway() -> Breakaway {
    let mut in_job = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) } == 0 || in_job == 0 {
        return Breakaway::NotInJob;
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        QueryInformationJobObject(null_mut(), JobObjectExtendedLimitInformation, &mut limits as *mut _ as *mut _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32, null_mut())
    };
    if ok == 0 {
        return Breakaway::Denied;
    }
    let flags = limits.BasicLimitInformation.LimitFlags;
    if flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0 {
        Breakaway::Allowed { silent: true }
    } else if flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 {
        Breakaway::Allowed { silent: false }
    } else {
        Breakaway::Denied
    }
}
