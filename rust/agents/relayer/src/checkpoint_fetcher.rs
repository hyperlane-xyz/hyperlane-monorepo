use std::time::Duration;

use eyre::Result;
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{sync::watch::Sender, task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument, instrument::Instrumented, Instrument};

use abacus_base::MultisigCheckpointSyncer;
use abacus_core::{MultisigSignedCheckpoint, Mailbox};

pub(crate) struct CheckpointFetcher {
    polling_interval: u64,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    signed_checkpoint_sender: Sender<Option<MultisigSignedCheckpoint>>,
    signed_checkpoint_gauge: IntGauge,
}

impl CheckpointFetcher {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        mailbox: &dyn Mailbox,
        polling_interval: u64,
        multisig_checkpoint_syncer: MultisigCheckpointSyncer,
        signed_checkpoint_sender: Sender<Option<MultisigSignedCheckpoint>>,
        leaf_index_gauge: IntGaugeVec,
    ) -> Self {
        let signed_checkpoint_gauge = leaf_index_gauge.with_label_values(&[
            "signed_offchain_checkpoint",
            mailbox.chain_name(),
            "unknown", // Checkpoints are not remote-specific
        ]);
        Self {
            polling_interval,
            multisig_checkpoint_syncer,
            signed_checkpoint_sender,
            signed_checkpoint_gauge,
        }
    }

    // Returns the latest signed checkpoint index
    #[instrument(ret, err, skip(self))]
    async fn fetch_and_send_signed_checkpoint(
        &mut self,
        latest_signed_checkpoint_index: u32,
        signed_checkpoint_index: u32,
    ) -> Result<u32> {
        // If the checkpoint storage is inconsistent, then this arm won't match
        // and it will cause us to have skipped this message batch
        if let Some(latest_signed_checkpoint) = self
            .multisig_checkpoint_syncer
            .fetch_checkpoint(signed_checkpoint_index)
            .await?
        {
            debug!(
                signed_checkpoint_index = signed_checkpoint_index,
                "Sending a newly fetched signed checkpoint via channel"
            );
            // Send the signed checkpoint to the message processor.
            self.signed_checkpoint_sender
                .send(Some(latest_signed_checkpoint.clone()))?;

            Ok(latest_signed_checkpoint.checkpoint.index)
        } else {
            Ok(latest_signed_checkpoint_index)
        }
    }

    #[instrument(ret, err, skip(self), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut latest_signed_checkpoint_index = 0;

        info!(
            latest_signed_checkpoint_index=?latest_signed_checkpoint_index,
            "Starting CheckpointFetcher"
        );

        loop {
            sleep(Duration::from_secs(self.polling_interval)).await;

            if let Some(signed_checkpoint_index) =
                self.multisig_checkpoint_syncer.latest_index().await?
            {
                self.signed_checkpoint_gauge
                    .set(signed_checkpoint_index as i64);
                if signed_checkpoint_index <= latest_signed_checkpoint_index {
                    debug!(
                        latest = latest_signed_checkpoint_index,
                        signed = signed_checkpoint_index,
                        "Signed checkpoint is less than or equal to latest known checkpoint, continuing"
                    );
                    continue;
                }

                // Fetch the new signed checkpoint and send it over the channel
                latest_signed_checkpoint_index = self
                    .fetch_and_send_signed_checkpoint(
                        latest_signed_checkpoint_index,
                        signed_checkpoint_index,
                    )
                    .await?;
            }
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointFetcher");
        tokio::spawn(self.main_loop()).instrument(span)
    }
}
