use std::ffi::OsStr;
use std::path::Path;
use std::process::{ExitStatus, Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(crate) const MAX_COMMAND_PIPE_BYTES: usize = 512 * 1024;

pub(crate) fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    command
}

pub(crate) async fn bounded_command_output(
    program: &Path,
    args: &[&str],
    deadline: Duration,
    label: &str,
) -> Result<Output, String> {
    let mut command = hidden_command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| format!("Could not run {label}: {error}"))?;
    bounded_child_output(child, deadline, label).await
}

async fn bounded_child_output(
    mut child: Child,
    deadline: Duration,
    label: &str,
) -> Result<Output, String> {
    #[cfg(windows)]
    let job = match create_kill_on_close_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(format!("Could not contain {label}: {error}"));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {label} stdout."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {label} stderr."))?;

    let outcome = tokio::time::timeout(deadline, async {
        let (stdout, stderr, status) = tokio::try_join!(
            read_bounded_pipe(stdout, label, "stdout"),
            read_bounded_pipe(stderr, label, "stderr"),
            wait_for_child(&mut child, label),
        )?;
        Ok::<_, String>((status, stdout, stderr))
    })
    .await;

    match outcome {
        Ok(Ok((status, stdout, stderr))) => Ok(Output {
            status,
            stdout,
            stderr,
        }),
        Ok(Err(error)) => {
            stop_child(
                &mut child,
                #[cfg(windows)]
                &job,
            )
            .await;
            Err(error)
        }
        Err(_) => {
            stop_child(
                &mut child,
                #[cfg(windows)]
                &job,
            )
            .await;
            Err(format!(
                "{label} timed out after {} seconds.",
                deadline.as_secs()
            ))
        }
    }
}

async fn read_bounded_pipe<R: AsyncRead + Unpin>(
    mut reader: R,
    label: &str,
    pipe: &str,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Could not read {label} {pipe}: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > MAX_COMMAND_PIPE_BYTES {
            return Err(format!(
                "{label} {pipe} exceeded the {MAX_COMMAND_PIPE_BYTES}-byte limit."
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn wait_for_child(child: &mut Child, label: &str) -> Result<ExitStatus, String> {
    child
        .wait()
        .await
        .map_err(|error| format!("Could not wait for {label}: {error}"))
}

pub(crate) fn terminate_process_tree(_child: &Child, #[cfg(windows)] job: &OwnedHandle) {
    #[cfg(windows)]
    terminate_job(job);
    #[cfg(unix)]
    if let Some(process_group) = _child.id() {
        unsafe {
            let _ = libc::kill(-(process_group as i32), libc::SIGKILL);
        }
    }
}

pub(crate) async fn stop_child(child: &mut Child, #[cfg(windows)] job: &OwnedHandle) {
    terminate_process_tree(
        child,
        #[cfg(windows)]
        job,
    );
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(windows)]
pub(crate) fn create_kill_on_close_job(child: &Child) -> Result<OwnedHandle, String> {
    let process = child
        .raw_handle()
        .ok_or_else(|| "The child process handle is unavailable.".to_string())?;
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(job)
}

#[cfg(windows)]
pub(crate) fn terminate_job(job: &OwnedHandle) {
    unsafe {
        let _ = TerminateJobObject(job.as_raw_handle(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn emit_oversized_stdout_for_parent_test() {
        print!("{}", "x".repeat(MAX_COMMAND_PIPE_BYTES + 1));
    }

    #[test]
    #[ignore]
    fn sleep_then_write_marker_for_parent_test() {
        let marker = std::env::var_os("OPEN_XIAO_CHILD_PROCESS_MARKER").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(marker, b"orphaned").unwrap();
    }

    #[test]
    #[ignore]
    fn spawn_descendant_then_wait_for_parent_test() {
        let executable = std::env::current_exe().unwrap();
        let mut descendant = std::process::Command::new(executable)
            .args([
                "--ignored",
                "--exact",
                "child_process::tests::sleep_then_write_marker_for_parent_test",
                "--nocapture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _ = descendant.wait();
    }

    #[tokio::test]
    async fn bounded_output_rejects_and_stops_an_overflowing_child() {
        let executable = std::env::current_exe().unwrap();
        let error = bounded_command_output(
            &executable,
            &[
                "--ignored",
                "--exact",
                "child_process::tests::emit_oversized_stdout_for_parent_test",
                "--nocapture",
            ],
            Duration::from_secs(5),
            "overflow test child",
        )
        .await
        .unwrap_err();

        assert!(error.contains("stdout exceeded"), "{error}");
    }

    #[tokio::test]
    async fn deadline_stops_the_owned_child_instead_of_orphaning_it() {
        let executable = std::env::current_exe().unwrap();
        let marker = std::env::temp_dir().join(format!(
            "open-xiao-child-timeout-{}-{}",
            std::process::id(),
            crate::child_process::tests::now_nanos()
        ));
        let mut command = hidden_command(&executable);
        command
            .args([
                "--ignored",
                "--exact",
                "child_process::tests::spawn_descendant_then_wait_for_parent_test",
                "--nocapture",
            ])
            .env("OPEN_XIAO_CHILD_PROCESS_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().unwrap();

        let error = bounded_child_output(child, Duration::from_millis(50), "timeout test child")
            .await
            .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!marker.exists(), "timed-out child was left running");
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }
}
