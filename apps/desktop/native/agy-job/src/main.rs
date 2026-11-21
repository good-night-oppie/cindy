// The executable owns the only job handle. No member can run before assignment.
// Dropping or losing the owner terminates all members, even after the root exits.
use std::{
    env,
    ffi::OsStr,
    fs::File,
    io,
    mem::{size_of, size_of_val, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    ptr::{null, null_mut},
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE},
        JobObjects::*,
        Pipes::CreatePipe,
        Threading::*,
    },
};

fn check(ok: BOOL) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn owned(h: HANDLE) -> io::Result<OwnedHandle> {
    if h.is_null() || h == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(h) })
    }
}
fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

// Mutable buffer for STARTUPINFOEX attributes, aligned to pointer width.
struct Attributes(Vec<usize>);
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        }
        let mut data = vec![0usize; size.div_ceil(size_of::<usize>())];
        unsafe {
            check(InitializeProcThreadAttributeList(
                data.as_mut_ptr().cast(),
                2,
                0,
                &mut size,
            ))?;
        }
        Ok(Self(data))
    }
    fn add<T>(&mut self, key: u32, values: &[T]) -> io::Result<()> {
        unsafe {
            check(UpdateProcThreadAttribute(
                self.0.as_mut_ptr().cast(),
                0,
                key as usize,
                values.as_ptr().cast(),
                size_of_val(values),
                null_mut(),
                null(),
            ))
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}

fn run() -> io::Result<i32> {
    // Host supplies the exact child command line as data. No shell interprets it.
    let args: Vec<_> = env::args_os().skip(1).collect();
    let probe = args.len() == 5 && args[4] == "--version-check";
    if args.len() != 4 && !probe {
        return Err(io::Error::other("invalid launch arguments"));
    }
    let parent_pid = args[0]
        .to_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::other("invalid parent process"))?;
    let (cwd, app, mut command) = (wide(&args[1]), wide(&args[2]), wide(&args[3]));
    unsafe {
        let parent = owned(OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid))?;
        let job = owned(CreateJobObjectW(null(), null()))?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ))?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (mut read, mut write) = (null_mut(), null_mut());
        check(CreatePipe(&mut read, &mut write, &sa, 0))?;
        let input = owned(read)?;
        let mut writer = File::from(owned(write)?);
        let eof = owned(CreateEventW(null(), 1, 0, null()))?;
        let pump_eof = eof.try_clone()?;
        let streams = [
            input.as_raw_handle(),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetStdHandle(STD_ERROR_HANDLE),
        ];
        let jobs = [job.as_raw_handle()];
        let mut attrs = Attributes::new()?;
        attrs.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &streams)?;
        attrs.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.lpAttributeList = attrs.0.as_mut_ptr().cast();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = streams[0];
        startup.StartupInfo.hStdOutput = streams[1];
        startup.StartupInfo.hStdError = streams[2];
        let mut process: PROCESS_INFORMATION = zeroed();
        check(CreateProcessW(
            app.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        ))?;
        let root = owned(process.hProcess)?;
        drop(owned(process.hThread)?);
        drop(input);
        thread::Builder::new().spawn(move || {
            let _ = io::copy(&mut io::stdin().lock(), &mut writer);
            drop(writer);
            SetEvent(pump_eof.as_raw_handle());
        })?;
        let wait = [
            root.as_raw_handle(),
            parent.as_raw_handle(),
            eof.as_raw_handle(),
        ];
        // A version check needs no input. Its status belongs to the root command.
        let count = if probe { 2 } else { 3 };
        let signal = WaitForMultipleObjects(count, wait.as_ptr(), 0, INFINITE);
        if signal == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0;
        if probe && signal == WAIT_OBJECT_0 {
            check(GetExitCodeProcess(root.as_raw_handle(), &mut code))?;
        }
        check(TerminateJobObject(job.as_raw_handle(), 1))?;
        loop {
            let mut counts: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            check(QueryInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut counts as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&counts) as u32,
                null_mut(),
            ))?;
            if counts.ActiveProcesses == 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(code as i32)
    }
}
fn main() {
    let code = run().unwrap_or_else(|error| {
        eprintln!("Windows helper could not start or supervise Antigravity: {error}");
        1
    });
    std::process::exit(code);
}
