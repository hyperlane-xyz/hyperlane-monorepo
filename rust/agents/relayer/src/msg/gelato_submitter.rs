use tokio::task::JoinHandle;

use abacus_base::chains::GelatoConf;
use eyre::{Context, Result, WrapErr};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::{info, info_span, instrument::Instrumented, warn, Instrument};
use super::SubmitMessageOp;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    rx: mpsc::Receiver<SubmitMessageOp>,
}

impl GelatoSubmitter {
    pub fn new(cfg: GelatoConf, rx: mpsc::Receiver<SubmitMessageOp>) -> Self {
        assert!(cfg.enabled);
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
            sleep(
              tokio::time::Duration::from_secs(86400 * 365)).await;
        }
        Ok(())
    }
}
