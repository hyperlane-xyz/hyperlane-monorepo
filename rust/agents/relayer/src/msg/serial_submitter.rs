use tokio::sync::mpsc;
use tracing::{info, info_span, instrument::Instrumented, warn, Instrument};
use tokio::task::JoinHandle;
use crate::msg::SubmitMessageOp;
use eyre::{Context, Result, WrapErr};

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
    pub fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }
    async fn work_loop(&self) -> Result<()> {
        // TODO(webbhorn):
        // - ===> Waiting for validation checkpoint queue
        // - ===> Waiting for funding queue
        // - ===> Send queue
        // - Forever:
        //   -  Pull rx work
        //   -  Categorize new work into ckpt_q, fund_q, or send_q.
        //   -  Move work through queues
        //   -  Pick next ready work that sorts best for some queue metric
        //      (most recent)?
        for _ in 1..1000 {
            tokio::time::sleep(
              tokio::time::Duration::from_secs(86400 * 365)).await;
        }
        Ok(())
    }
}
