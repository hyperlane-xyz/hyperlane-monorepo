use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::Arc;

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::SubmitMessageOp;
use abacus_base::{InboxContracts, Outboxes, CachingInterchainGasPaymaster};
use abacus_core::db::AbacusDB;
use abacus_core::MultisigSignedCheckpoint;
use eyre::Result;
use tokio::task::JoinHandle;
use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};
use tracing::{info_span, instrument::Instrumented, Instrument};

// TODO(webbhorn): Take dep on interchain gas paymaster indexed data.
// TODO(webbhorn): Metrics data.

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct SerialSubmitter {
    // Receiver for new messages to submit.
    rx: mpsc::Receiver<SubmitMessageOp>,

    // Messages we are aware of that we want to eventually submit,
    // but haven't yet, for whatever reason.
    retry_queue: BinaryHeap<MessageToRetry>,

    // Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,

    // Outbox on message origin chain.
    outbox: Outboxes,

    // Contract tracking interchain gas payments for use when deciding whether
    // sufficient funds have been provided for message forwarding.
    interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,

    // The number of times to attepmt submitting each message
    // before giving up.
    //
    // TODO(webbhorn): Is this the number of attempts we'll make before permanently
    // giving up, or until we re-insert into retry queue and try the next readiest message?
    max_retries: u32,

    // Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,

    // Interface to generating merkle proofs for messages against a checkpoint.
    prover_sync: MerkleTreeBuilder,

    // Provides access to most-recently available signed checkpoint.
    signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
}

impl SerialSubmitter {
    pub(crate) fn new(
        rx: mpsc::Receiver<SubmitMessageOp>,
        inbox_contracts: InboxContracts,
        outbox: Outboxes,
        interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,
        max_retries: u32,
        db: AbacusDB,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Self {
        Self {
            rx,
            retry_queue: BinaryHeap::new(),
            inbox_contracts,
            outbox,
            interchain_gas_paymaster,
            max_retries,
            db: db.clone(),
            prover_sync: MerkleTreeBuilder::new(db),
            signed_checkpoint_receiver,
        }
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
