use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, instrument, warn};

use crate::{
    adapter::TxBuildingResult,
    error::LanderError,
    payload::{DropReason, FullPayload, PayloadDetails, PayloadStatus},
    transaction::Transaction,
};

use super::super::utils::call_until_success_or_nonretryable_error;
use super::super::DispatcherState;
use super::queue::BuildingStageQueue;

pub const STAGE_NAME: &str = "BuildingStage";

#[derive(new)]
pub struct BuildingStage {
    /// This queue is the entrypoint and event driver of the Building Stage
    queue: BuildingStageQueue,
    /// This channel is the exitpoint of the Building Stage
    inclusion_stage_sender: mpsc::Sender<Transaction>,
    pub(crate) state: DispatcherState,
    domain: String,
}

impl BuildingStage {
    #[instrument(skip(self), name = "BuildingStage::run")]
    pub async fn run(&self) {
        loop {
            self.update_metrics().await;
            // event-driven by the Building queue
            let payloads = self
                .queue
                .pop_n(self.state.adapter.max_batch_size() as usize)
                .await;
            if payloads.is_empty() {
                // wait for more payloads to arrive
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                continue;
            }

            info!(?payloads, "Building transactions from payloads");
            let tx_building_results = self.state.adapter.build_transactions(&payloads).await;

            for tx_building_result in tx_building_results {
                // push payloads that failed to be processed (but didn't fail simulation)
                // to the back of the queue
                if let Err(err) = self
                    .handle_tx_building_result(tx_building_result.clone())
                    .await
                {
                    error!(?err, payloads=?tx_building_result.payloads, "Error handling tx building result");
                    let full_payloads =
                        get_full_payloads_from_details(&payloads, &tx_building_result.payloads);
                    self.queue.extend(full_payloads).await;
                }
            }
        }
    }

    #[instrument(
        skip(self, tx_building_result),
        name = "BuildingStage::handle_tx_building_result",
        fields(
            payloads = ?tx_building_result.payloads,
            tx_uuids = ?tx_building_result.maybe_tx.as_ref().map(|tx| tx.uuid.to_string()),
        )
    )]
    async fn handle_tx_building_result(
        &self,
        tx_building_result: TxBuildingResult,
    ) -> eyre::Result<(), LanderError> {
        let TxBuildingResult { payloads, maybe_tx } = tx_building_result;
        let Some(tx) = maybe_tx else {
            warn!(
                ?payloads,
                "Transaction building failed. Dropping transaction"
            );
            self.state
                .update_status_for_payloads(
                    &payloads,
                    PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction),
                )
                .await;
            return Ok(());
        };
        info!(?tx, "Transaction built successfully");
        call_until_success_or_nonretryable_error(
            || self.send_tx_to_inclusion_stage(tx.clone()),
            "Sending transaction to inclusion stage",
            &self.state,
        )
        .await?;
        self.state.store_tx(&tx).await;
        Ok(())
    }

    async fn send_tx_to_inclusion_stage(&self, tx: Transaction) -> eyre::Result<(), LanderError> {
        if let Err(err) = self.inclusion_stage_sender.send(tx.clone()).await {
            return Err(LanderError::ChannelSendFailure(err));
        }
        info!(?tx, "Transaction sent to Inclusion Stage");
        Ok(())
    }

    async fn update_metrics(&self) {
        self.state
            .metrics
            .update_liveness_metric(STAGE_NAME, &self.domain);
        let length = self.queue.len().await;
        self.state
            .metrics
            .update_queue_length_metric(STAGE_NAME, length as u64, &self.domain);
    }
}

fn get_full_payloads_from_details(
    full_payloads: &[FullPayload],
    details: &[PayloadDetails],
) -> Vec<FullPayload> {
    full_payloads
        .iter()
        .filter(|payload| details.iter().any(|d| d.uuid == payload.details.uuid))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests;
