use std::sync::Arc;

use abacus_base::CachingInterchainGasPaymaster;
use abacus_core::{db::AbacusDB, MultisigSignedCheckpoint};
use tokio::task::JoinHandle;

use crate::merkle_tree_builder::MerkleTreeBuilder;

use abacus_base::{chains::GelatoConf, InboxContracts};
use eyre::Result;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tracing::{info_span, instrument::Instrumented, Instrument};

use super::SubmitMessageArgs;

// TODO(webbhorn): Metrics data.

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    rx: mpsc::Receiver<SubmitMessageArgs>,

    // Interface to Inbox / InboxValidatorManager on the destination chain.
    // Will be useful in retry logic to determine whether or not to re-submit
    // forward request to Gelato, if e.g. we have confirmation via inbox syncer
    // that the message has already been submitted by some other relayer.
    inbox_contracts: InboxContracts,

    // Contract tracking interchain gas payments for use when deciding whether
    // sufficient funds have been provided for message forwarding.
    interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,

    // Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,

    // Interface to generating merkle proofs for messages against a checkpoint.
    prover_sync: MerkleTreeBuilder,
}

impl GelatoSubmitter {
    pub fn new(
        cfg: GelatoConf,
        rx: mpsc::Receiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,
        db: AbacusDB,
    ) -> Self {
        assert!(cfg.enabled_for_message_submission);
        Self {
            rx,
            inbox_contracts,
            interchain_gas_paymaster,
            db: db.clone(),
            prover_sync: MerkleTreeBuilder::new(db),
        }
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
            if self.rx.recv().await.is_none() {
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
