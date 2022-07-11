use abacus_base::{chains::GelatoConf, InboxContracts};
use abacus_core::{db::AbacusDB, Signers};
use tokio::task::JoinHandle;

use eyre::Result;
use tokio::sync::mpsc;
use tracing::{info_span, instrument::Instrumented, Instrument};

use super::SubmitMessageArgs;

// TODO(webbhorn): Metrics data.
// TODO(webbhorn): Pull in ForwardRequestOp logic from prior branch.

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    rx: mpsc::UnboundedReceiver<SubmitMessageArgs>,

    /// Interface to Inbox / InboxValidatorManager on the destination chain.
    /// Will be useful in retry logic to determine whether or not to re-submit
    /// forward request to Gelato, if e.g. we have confirmation via inbox syncer
    /// that the message has already been submitted by some other relayer.
    inbox_contracts: InboxContracts,

    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,

    /// Signer to use for EIP-712 meta-transaction signatures.
    signer: Signers,
}

impl GelatoSubmitter {
    pub fn new(
        cfg: GelatoConf,
        rx: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        db: AbacusDB,
        signer: Signers,
    ) -> Self {
        assert!(cfg.enabled_for_message_submission);
        Self {
            rx,
            inbox_contracts,
            db,
            signer,
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }

    /// The Gelato relay framework allows us to submit ops in
    /// parallel, subject to certain retry rules. Therefore all we do
    /// here is spin forever asking for work from the rx channel, then
    /// spawn the work to submit to gelato in a root tokio task.
    ///
    /// It is possible that there has not been sufficient interchain
    /// gas deposited in the InterchainGasPaymaster account on the source
    /// chain, so we also keep a wait queue of ops that we
    /// periodically scan for any gas updates.
    ///
    /// In the future one could maybe imagine also applying a global
    /// rate-limiter against the relevant Gelato HTTP endpoint or
    /// something, or a max-inflight-cap on Gelato messages from
    /// relayers, enforced here. But probably not until that proves to
    /// be necessary.
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            tokio::task::yield_now().await;
        }
    }

    /// Extracted from main loop to enable testing submitter state
    /// after each tick, e.g. in response to a change in environment
    /// conditions like values in InterchainGasPaymaster.
    async fn tick(&self) -> Result<()> {
        // TODO(webbhorn): Pull all available messages out of self.rx
        // and check if enough gas to process them. If not, put on
        // wait queue. If there is enough, spawn root task and run
        // the fwd req op.

        // TODO(webbhorn): Scan pending queue for any newly-eligible
        // ops and if encountered, spawn them in a root task.
        // Remove them from pending queue if so.

        // TODO(webbhorn): Either wait for finality in the ForwardRequestOp
        // logic, or follow the pattern from serial_submitter.rs
        // of implementing a verification queue, where we will stash
        // successfully submitted ops that have not yet reached finality.
        // Only after reaching finality will we commit the new status to
        // AbacusDB and drop those messages from the verification queue.
        // In case of a destination chain re-org, they would need
        // to go back to the wait queue.

        // TODO(webbhorn): monitoring / metrics.

        unimplemented!()
    }
}
