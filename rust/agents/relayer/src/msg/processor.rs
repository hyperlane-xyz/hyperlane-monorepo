use std::{sync::Arc, time::Duration};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{sleep, Instant},
};
use tracing::{info_span, instrument, instrument::Instrumented, Instrument};

use abacus_base::{CoreMetrics, InboxContracts};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, CommittedMessage, MultisigSignedCheckpoint,
};

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::whitelist::Whitelist};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    pub(crate) outbox_db: AbacusDB,
    pub(crate) inbox_contracts: InboxContracts,
    pub(crate) whitelist: Arc<Whitelist>,
    pub(crate) msg_send_chan: mpsc::UnboundedSender<SubmitMessageArgs>,
    pub(crate) checkpoints: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    pub(crate) prover_sync: MerkleTreeBuilder,
    pub(crate) metrics: MessageProcessorMetrics,
}

impl MessageProcessor {
    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.main_loop().await }).instrument(info_span!("processor"))
    }

    #[instrument(ret, err, skip(self),
        fields(
            inbox_name=self.inbox_contracts.inbox.chain_name(),
            local_domain=?self.inbox_contracts.inbox.local_domain()),
    )]
    async fn main_loop(mut self) -> Result<()> {
        for index in 0.. {
            self.tick(index).await?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    #[instrument(
        skip(self),
        fields(inbox_name=self.inbox_contracts.inbox.chain_name()),
        level="debug")
    ]
    async fn tick(&mut self, index: u32) -> Result<()> {
        self.metrics.update_current_index(index);
        if self.msg_already_processed(index)? {
            return Ok(());
        }
        let msg = self.wait_for_committed_message(index).await?;
        if !self.inbox_domain_matches(&msg)? {
            return Ok(());
        }
        if !self.whitelist.msg_matches(&msg.message) {
            return Ok(());
        }
        let checkpoint = self.wait_for_covering_checkpoint(index).await?;
        self.prover_sync
            .update_to_checkpoint(&checkpoint.checkpoint)
            .await?;
        let proof = self.prover_sync.get_proof(index)?;
        self.outbox_db.wait_for_leaf(index).await?; // why?
        let submit_args = SubmitMessageArgs::new(index, msg, checkpoint, proof, Instant::now());
        self.msg_send_chan.send(submit_args)?;
        Ok(())
    }

    fn msg_already_processed(&self, index: u32) -> Result<bool> {
        Ok(self
            .outbox_db
            .retrieve_leaf_processing_status(index)?
            .is_some())
    }

    async fn wait_for_committed_message(&self, index: u32) -> Result<CommittedMessage> {
        loop {
            if let Some(committed_message) = self
                .outbox_db
                .message_by_leaf_index(index)?
                .map(CommittedMessage::try_from)
                .transpose()?
            {
                return Ok(committed_message);
            };
            sleep(Duration::from_millis(100)).await
        }
    }

    fn inbox_domain_matches(&self, msg: &CommittedMessage) -> Result<bool> {
        Ok(msg.message.destination == self.inbox_contracts.inbox.local_domain())
    }

    // lol, fix the clones.
    async fn wait_for_covering_checkpoint(
        &mut self,
        index: u32,
    ) -> Result<MultisigSignedCheckpoint> {
        loop {
            let c: Option<MultisigSignedCheckpoint> = self.checkpoints.borrow_and_update().clone();
            if c.clone().is_some() && c.clone().unwrap().checkpoint.index >= index {
                return Ok(c.clone().unwrap());
            }
            self.checkpoints.changed().await?;
        }
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    processor_loop_gauge: IntGauge,
}

impl MessageProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "processor_loop",
                outbox_chain,
                inbox_chain,
            ]),
        }
    }

    fn update_current_index(&self, new_index: u32) {
        self.processor_loop_gauge.set(new_index as i64);
    }
}
