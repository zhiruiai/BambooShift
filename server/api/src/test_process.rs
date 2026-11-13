//! Independent process observations for tests that hand ownership to a supervisor.

use std::{io, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Child};

const CHILD_MARKER: &str = "BAMBOOSHIFT_SYNTHETIC_WAITING_CHILD";
const READY: &[u8] = b"synthetic child ready\n";

pub(crate) struct ProcessProbe {
    #[cfg(unix)]
    pid: libc::pid_t,
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
}

impl ProcessProbe {
    /// Attach while the child is alive, before asking its supervisor to stop it.
    pub(crate) fn attach(pid: u32) -> io::Result<Self> {
        if pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid child PID",
            ));
        }
        #[cfg(unix)]
        let probe = Self {
            pid: pid
                .try_into()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid child PID"))?,
        };
        #[cfg(windows)]
        let probe = {
            use std::os::windows::io::{FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            // Keep a handle to this process, not a PID that might later be reused.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            Self {
                handle: unsafe { OwnedHandle::from_raw_handle(handle) },
            }
        };
        if !probe.is_running()? {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Child already exited",
            ));
        }
        Ok(probe)
    }

    pub(crate) fn is_running(&self) -> io::Result<bool> {
        #[cfg(unix)]
        {
            if unsafe { libc::kill(self.pid, 0) } == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error)
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => Ok(true),
                WAIT_OBJECT_0 => Ok(false),
                WAIT_FAILED => Err(io::Error::last_os_error()),
                _ => Err(io::Error::other("Unexpected process wait result")),
            }
        }
    }

    pub(crate) async fn wait_for_exit(&self, limit: Duration) -> io::Result<()> {
        tokio::time::timeout(limit, async {
            while self.is_running()? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Child did not exit"))?
    }
}

/// Launch only the ignored synthetic child test, and confirm its readiness before returning.
pub(crate) async fn spawn_waiting_child() -> io::Result<(Child, ProcessProbe)> {
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "test_process::waiting_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MARKER, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let ready = async {
        let probe = ProcessProbe::attach(
            child
                .id()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Child has no PID"))?,
        )?;
        let stdout = child.stdout.as_mut().unwrap();
        let mut output = Vec::new();
        for _ in 0..4096 {
            // Read one byte so the returned pipe retains any subsequent child output.
            output.push(stdout.read_u8().await?);
            if output.ends_with(READY) {
                return Ok(probe);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Child did not signal readiness",
        ))
    };
    let result = tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap_or_else(|_| {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Child did not start",
            ))
        });
    match result {
        Ok(probe) => Ok((child, probe)),
        Err(error) => {
            let _ = child.start_kill();
            child.wait().await?;
            Err(error)
        }
    }
}

#[test]
#[ignore = "Invoked only as the synthetic subprocess of process lifecycle tests"]
fn waiting_child() {
    use std::io::Write;
    assert_eq!(std::env::var(CHILD_MARKER).as_deref(), Ok("1"));
    std::io::stdout().write_all(READY).unwrap();
    std::io::stdout().flush().unwrap();
    // The parent must terminate this process; a bounded fallback prevents orphaned fixtures.
    std::thread::sleep(Duration::from_secs(60));
}

#[tokio::test]
async fn probe_distinguishes_live_timeout_from_confirmed_exit() {
    assert!(ProcessProbe::attach(0).is_err());
    let (mut child, probe) = spawn_waiting_child().await.unwrap();
    assert!(probe.is_running().unwrap());
    assert_eq!(
        probe
            .wait_for_exit(Duration::from_millis(20))
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    child.start_kill().unwrap();
    child.wait().await.unwrap();
    probe.wait_for_exit(Duration::from_secs(2)).await.unwrap();
    assert!(!probe.is_running().unwrap());
}
