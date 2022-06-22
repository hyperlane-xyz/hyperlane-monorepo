use std::cmp::Reverse;

use crate::msg::SubmitMessageOp;
use eyre::Result;
use tokio::task::JoinHandle;
use tokio::{sync::mpsc, time::Instant};
use tracing::{info_span, instrument::Instrumented, Instrument};

pub(crate) struct SerialSubmitter {
    rx: mpsc::Receiver<SubmitMessageOp>,
    // TODO(webbhorn): Pending queue.
    // TODO(webbhorn): Retry queue.
    // TODO(webbhorn): Metrics.
    // TODO(webbhorn): DB.
}

impl SerialSubmitter {
    pub fn new(rx: mpsc::Receiver<SubmitMessageOp>) -> Self {
        Self { rx }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }

    async fn work_loop(&mut self) -> Result<()> {
        loop {
            if self.rx.recv().await.is_none() {
                break;
            }

            // TODO(webbhorn): Rule: if new message is available for
            // processing, try it before doing anything with retry
            // backlog. That looks like receiving from channel until
            // it is empty, then trying retry queue.

            // TODO(webbhorn): Check if enough gas. If not, put on
            // pending_gas queue. If there is, spawn it and run the op
            // in its own task.

            // TODO(webbhorn): Scan pending queue for any newly-eligible
            // ops and if encountered, spawn them in root task.
            // Remove them from pending queue.
            //
            // Also look for 'expired' ops, i.e. those created >= time ago.
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MessageToRetry {
    time_to_retry: Reverse<Instant>,
    leaf_index: u32,
    retries: u32,
}
