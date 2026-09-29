//! Runs snarkVM circuit synthesis on one dedicated OS thread.
//!
//! Checked authorization synthesizes the whole function circuit in a
//! thread-local environment. On Tokio workers this stalls the runtime for
//! seconds, and each worker's glibc arena keeps the freed peak once other work
//! allocates behind it. A single long-lived thread keeps that transient in one
//! arena and off the runtime. Once its queue drains, the thread returns freed
//! pages to the OS so the peak does not stay resident between jobs.

use std::{
    iter,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{mpsc, LazyLock},
    thread,
};

use tokio::sync::oneshot;
use tracing::error;

use hyperlane_core::ChainResult;

use crate::HyperlaneAleoError;

type Job = Box<dyn FnOnce() + Send>;

static VM_THREAD: LazyLock<mpsc::Sender<Job>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<Job>();
    thread::Builder::new()
        .name("aleo-vm".to_owned())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                for job in iter::once(first).chain(receiver.try_iter()) {
                    // The caller observes a panic as a dropped result channel.
                    if catch_unwind(AssertUnwindSafe(job)).is_err() {
                        error!("Aleo VM job panicked");
                    }
                }
                release_free_memory();
            }
        })
        .expect("Failed to spawn Aleo VM thread");
    sender
});

/// Returns free heap pages to the OS. glibc otherwise keeps a freed synthesis
/// peak resident. `malloc_trim` walks every arena, briefly locking each.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn release_free_memory() {
    // SAFETY: malloc_trim only releases memory that is already free.
    unsafe { libc::malloc_trim(0) };
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn release_free_memory() {}

/// Runs `job` on the Aleo VM thread. Jobs run one at a time, in order.
/// A job whose caller is cancelled before it starts is skipped; a started job
/// runs to completion.
pub(crate) async fn run<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> ChainResult<T> {
    let (sender, receiver) = oneshot::channel();
    VM_THREAD
        .send(Box::new(move || {
            // Skip queued work whose caller was cancelled while waiting.
            if !sender.is_closed() {
                let _ = sender.send(job());
            }
        }))
        .map_err(|_| HyperlaneAleoError::Other("Aleo VM thread stopped".to_owned()))?;
    receiver
        .await
        .map_err(|_| HyperlaneAleoError::Other("Aleo VM job panicked".to_owned()).into())
}

#[cfg(test)]
mod tests {
    use std::{sync::atomic::Ordering, thread::ThreadId};

    use super::*;

    async fn thread_id() -> ThreadId {
        run(|| thread::current().id()).await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn jobs_share_one_thread_off_the_runtime() {
        let ids = futures::future::join_all((0..8).map(|_| tokio::spawn(thread_id()))).await;
        let first = ids[0].as_ref().unwrap();
        assert!(ids.iter().all(|id| id.as_ref().unwrap() == first));
        assert_ne!(*first, thread::current().id());
        assert!(run(|| tokio::runtime::Handle::try_current().is_err())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn cancelled_queued_job_is_skipped() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let blocker = tokio::spawn(run(move || blocked.recv().is_ok()));
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let queued = tokio::spawn(run(move || flag.store(true, Ordering::SeqCst)));
        // Wait until the queued job has been submitted, then cancel its caller.
        tokio::task::yield_now().await;
        queued.abort();
        assert!(queued.await.is_err());
        release.send(()).unwrap();
        assert!(blocker.await.unwrap().unwrap());
        // Jobs run in order, so this completes after the skipped job.
        thread_id().await;
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn panicking_job_errors_without_stopping_thread() {
        let before = thread_id().await;
        let result: ChainResult<()> = run(|| panic!("boom")).await;
        assert!(result.is_err());
        assert_eq!(thread_id().await, before);
    }
}
