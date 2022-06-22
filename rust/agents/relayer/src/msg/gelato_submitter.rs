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
    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }
    // The relay SDK framework allows us to submit ops in parallel,
    // subject to certain retry rules. Therefore all we do here is
    // spin forever asking for work from the rx channel, then spawn
    // the work to submit to gelato in a root tokio task.
    //
    // It is possible that there has not been sufficient interchain
    // gas deposited in the interchaingaspaymaster account on the source
    // chain, so we also keep a pending_gas queue of ops that we
    // periodically scan for any gas updates.
    //
    // In the future one could maybe imagine also applying a rate-limiter
    // or something, or a max-inflight-cap on Gelato messages from
    // relayres, enforced here.
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            let foo = self.rx.recv().await;
            if foo.is_none() {
                break;
            }

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
