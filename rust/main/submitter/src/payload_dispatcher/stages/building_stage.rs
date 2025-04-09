// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

use crate::{
    chain_tx_adapter::TxBuildingResult,
    error::SubmitterError,
    payload::{DropReason, FullPayload, PayloadDetails, PayloadStatus},
    transaction::Transaction,
};

use super::{state::PayloadDispatcherState, utils::retry_until_success};

pub type BuildingStageQueue = Arc<Mutex<VecDeque<FullPayload>>>;

#[derive(new)]
pub(crate) struct BuildingStage {
    /// This queue is the entrypoint and event driver of the Building Stage
    queue: BuildingStageQueue,
    /// This channel is the exitpoint of the Building Stage
    inclusion_stage_sender: mpsc::Sender<Transaction>,
    pub(crate) state: PayloadDispatcherState,
}

impl BuildingStage {
    pub async fn run(&self) {
        loop {
            // event-driven by the Building queue
            let payload = match self.queue.lock().await.pop_front() {
                Some(payload) => payload,
                None => {
                    // wait for the next payload to arrive
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }
            };

            let payloads = vec![payload];
            let tx_building_results = retry_until_success(
                || self.state.adapter.build_transactions(&payloads),
                "Simulating transaction",
            )
            .await;

            for tx_building_result in tx_building_results {
                self.handle_tx_building_result(tx_building_result).await;
            }
        }
    }

    async fn handle_tx_building_result(&self, tx_building_result: TxBuildingResult) {
        let TxBuildingResult { payloads, maybe_tx } = tx_building_result;
        let Some(tx) = maybe_tx else {
            self.state
                .update_status_for_payloads(
                    &payloads,
                    PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction),
                )
                .await;
            return;
        };
        let simulation_success = retry_until_success(
            || self.state.adapter.simulate_tx(&tx),
            "Simulating transaction",
        )
        .await;
        if !simulation_success {
            warn!(
                ?tx,
                payload_details = ?tx.payload_details,
                "Transaction simulation failed. Dropping transaction"
            );
            self.drop_tx(&tx, DropReason::FailedSimulation).await;
            return;
        };
        retry_until_success(
            || self.send_tx_to_inclusion_stage(tx.clone()),
            "Sending transaction to inclusion stage",
        )
        .await;
        self.state.store_tx(&tx).await;
    }

    async fn drop_tx(&self, tx: &Transaction, reason: DropReason) {
        // Transactions are only persisted if they are sent to the Inclusion Stage
        // so the only thing to update in this stage is the payload status
        self.state
            .update_status_for_payloads(&tx.payload_details, PayloadStatus::Dropped(reason))
            .await;
    }

    async fn send_tx_to_inclusion_stage(&self, tx: Transaction) -> Result<(), SubmitterError> {
        if let Err(err) = self.inclusion_stage_sender.send(tx.clone()).await {
            return Err(SubmitterError::ChannelSendFailure(err));
        }
        info!(?tx, "Transaction sent to Inclusion Stage");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use eyre::Result;
    use std::{collections::VecDeque, sync::Arc};

    use crate::{
        chain_tx_adapter::{AdaptsChain, TxBuildingResult},
        payload::{self, DropReason, FullPayload, PayloadDetails, PayloadStatus},
        payload_dispatcher::{
            test_utils::{dummy_tx, initialize_payload_db, tmp_dbs, MockAdapter},
            PayloadDb, PayloadDispatcherState, TransactionDb,
        },
        transaction::{Transaction, TransactionStatus},
    };

    use super::{BuildingStage, BuildingStageQueue};

    #[tokio::test]
    async fn test_send_payloads_one_by_one() {
        const PAYLOADS_TO_SEND: usize = 3;
        let succesful_build = true;
        let successful_simulation = true;
        let (building_stage, mut receiver, queue) =
            test_setup(PAYLOADS_TO_SEND, succesful_build, successful_simulation);

        // send a single payload to the building stage and check that it is sent to the receiver
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::random();
            initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
            queue.lock().await.push_back(payload_to_send.clone());
            let payload_details_received =
                run_building_stage(1, &building_stage, &mut receiver).await;
            assert_eq!(
                payload_details_received,
                vec![payload_to_send.details.clone()]
            );
            assert_db_status_for_payloads(
                &building_stage.state,
                &payload_details_received,
                PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
            )
            .await;
        }
        assert_eq!(queue.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_send_multiple_payloads_at_once() {
        const PAYLOADS_TO_SEND: usize = 3;
        let succesful_build = true;
        let successful_simulation = true;
        let (building_stage, mut receiver, queue) =
            test_setup(PAYLOADS_TO_SEND, succesful_build, successful_simulation);

        let mut sent_payloads = Vec::new();
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::random();
            initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
            queue.lock().await.push_back(payload_to_send.clone());
            sent_payloads.push(payload_to_send);
        }

        // send multiple payloads to the building stage and check that they are sent to the receiver in the same order
        let payload_details_received =
            run_building_stage(PAYLOADS_TO_SEND, &building_stage, &mut receiver).await;
        let expected_payload_details = sent_payloads
            .iter()
            .map(|payload| payload.details.clone())
            .collect::<Vec<_>>();
        assert_eq!(payload_details_received, expected_payload_details);
        assert_db_status_for_payloads(
            &building_stage.state,
            &payload_details_received,
            PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
        )
        .await;
        assert_eq!(queue.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_txs_failed_to_build() {
        const PAYLOADS_TO_SEND: usize = 3;
        let succesful_build = false;
        let successful_simulation = true;
        let (building_stage, mut receiver, queue) =
            test_setup(PAYLOADS_TO_SEND, succesful_build, successful_simulation);

        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::random();
            initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
            queue.lock().await.push_back(payload_to_send.clone());
            let payload_details_received =
                run_building_stage(1, &building_stage, &mut receiver).await;
            assert_eq!(payload_details_received, vec![]);
            assert_db_status_for_payloads(
                &building_stage.state,
                &payload_details_received,
                PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction),
            )
            .await;
        }
        assert_eq!(queue.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_txs_failed_simulation() {
        const PAYLOADS_TO_SEND: usize = 3;
        let succesful_build = true;
        let successful_simulation = false;
        let (building_stage, mut receiver, queue) =
            test_setup(PAYLOADS_TO_SEND, succesful_build, successful_simulation);

        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::random();
            initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
            queue.lock().await.push_back(payload_to_send.clone());
            let payload_details_received =
                run_building_stage(1, &building_stage, &mut receiver).await;
            assert_eq!(payload_details_received, vec![]);
            assert_db_status_for_payloads(
                &building_stage.state,
                &payload_details_received,
                PayloadStatus::Dropped(DropReason::FailedSimulation),
            )
            .await;
        }
        assert_eq!(queue.lock().await.len(), 0);
    }

    async fn run_building_stage(
        sent_payload_count: usize,
        building_stage: &BuildingStage,
        receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
    ) -> Vec<PayloadDetails> {
        // future that receives `sent_payload_count` payloads from the building stage
        let received_payloads = async {
            let mut received_payloads = Vec::new();
            while received_payloads.len() < sent_payload_count {
                let tx_received = receiver.recv().await.unwrap();
                let payload_details_received = tx_received.payload_details;
                received_payloads.extend_from_slice(&payload_details_received);
            }
            received_payloads
        };

        // give the building stage 100ms to send the transaction(s) to the receiver
        tokio::select! {
            res = building_stage.run() => res,
            // this arm runs until all sent payloads are sent as txs
            payloads = received_payloads => {
                return payloads;
            },
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {},
        };
        vec![]
    }

    fn test_setup(
        payloads_to_send: usize,
        succesful_build: bool,
        successful_simulation: bool,
    ) -> (
        BuildingStage,
        tokio::sync::mpsc::Receiver<Transaction>,
        BuildingStageQueue,
    ) {
        let (payload_db, tx_db) = tmp_dbs();
        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_build_transactions()
            .times(payloads_to_send)
            .returning(move |payloads| {
                Ok(dummy_built_tx(payloads.to_vec(), succesful_build.clone()))
            });
        mock_adapter
            .expect_simulate_tx()
            // .times(payloads_to_send)
            .returning(move |_| Ok(successful_simulation.clone()));
        dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db)
    }

    fn dummy_stage_receiver_queue(
        mock_adapter: MockAdapter,
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
    ) -> (
        BuildingStage,
        tokio::sync::mpsc::Receiver<Transaction>,
        BuildingStageQueue,
    ) {
        let adapter = Arc::new(mock_adapter) as Arc<dyn AdaptsChain>;
        let state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
        let (sender, receiver) = tokio::sync::mpsc::channel(100);
        let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
        let building_stage = BuildingStage::new(queue.clone(), sender, state);
        (building_stage, receiver, queue)
    }

    fn dummy_built_tx(payloads: Vec<FullPayload>, success: bool) -> Vec<TxBuildingResult> {
        let details: Vec<PayloadDetails> = payloads
            .clone()
            .into_iter()
            .map(|payload| payload.details)
            .collect();
        let maybe_transaction = if success {
            Some(dummy_tx(payloads, TransactionStatus::PendingInclusion))
        } else {
            None
        };
        let tx_building_result = TxBuildingResult::new(details, maybe_transaction);
        vec![tx_building_result]
    }

    async fn assert_db_status_for_payloads(
        state: &PayloadDispatcherState,
        payloads: &[PayloadDetails],
        expected_status: PayloadStatus,
    ) {
        for payload in payloads {
            let payload_from_db = state
                .payload_db
                .retrieve_payload_by_id(&payload.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(payload_from_db.status, expected_status);
        }
    }
}
