//! Runs snarkVM circuit synthesis on one dedicated OS thread.
//!
//! Checked authorization synthesizes the whole function circuit in a
//! thread-local environment. On Tokio workers this stalls the runtime for
//! seconds, and each worker's glibc arena keeps the freed peak once other work
//! allocates behind it. A single long-lived thread keeps that transient in one
//! arena and off the runtime.

use std::{
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
            for job in receiver {
                // The caller observes a panic as a dropped result channel.
                if catch_unwind(AssertUnwindSafe(job)).is_err() {
                    error!("Aleo VM job panicked");
                }
            }
        })
        .expect("Failed to spawn Aleo VM thread");
    sender
});

/// Runs `job` on the Aleo VM thread. Jobs run one at a time, in order.
/// A cancelled caller does not cancel a started job.
pub(crate) async fn run<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> ChainResult<T> {
    let (sender, receiver) = oneshot::channel();
    VM_THREAD
        .send(Box::new(move || {
            // The caller may have been cancelled; its result is not needed.
            let _ = sender.send(job());
        }))
        .map_err(|_| HyperlaneAleoError::Other("Aleo VM thread stopped".to_owned()))?;
    receiver
        .await
        .map_err(|_| HyperlaneAleoError::Other("Aleo VM job panicked".to_owned()).into())
}

#[cfg(test)]
mod tests {
    use std::thread::ThreadId;

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
    async fn panicking_job_errors_without_stopping_thread() {
        let before = thread_id().await;
        let result: ChainResult<()> = run(|| panic!("boom")).await;
        assert!(result.is_err());
        assert_eq!(thread_id().await, before);
    }
}
