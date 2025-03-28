// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

use crate::{
    payload::{DropReason, FullPayload, PayloadDetails, PayloadStatus},
    transaction::Transaction,
};

use super::PayloadDispatcherState;

pub type BuildingStageQueue = Arc<Mutex<VecDeque<FullPayload>>>;

#[derive(new)]
struct BuildingStage {
    /// This queue is the entrypoint and event driver of the Building Stage
    queue: BuildingStageQueue,
    /// This channel is the exitpoint of the Building Stage
    inclusion_stage_sender: mpsc::Sender<Transaction>,
    state: PayloadDispatcherState,
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
            let txs = match self
                .state
                .adapter
                .build_transactions(payloads.clone())
                .await
            {
                Err(err) => {
                    error!(
                        ?err,
                        ?payloads,
                        "Error building transactions. Dropping payloads"
                    );
                    let details_for_payloads: Vec<_> =
                        payloads.into_iter().map(|p| p.details().clone()).collect();
                    self.drop_payloads(&details_for_payloads, DropReason::UnhandledError)
                        .await;
                    continue;
                }
                Ok(txs) => txs,
            };

            for tx in txs {
                if let Err(err) = self.simulate_tx(&tx).await {
                    error!(
                        ?err,
                        payload_details = ?tx.payload_details(),
                        "Error simulating transaction. Dropping transaction"
                    );
                    // TODO: distinguish between network error and failed simulation
                    self.drop_tx(&tx, DropReason::FailedSimulation).await;
                    continue;
                };
                if let Err(err) = self.send_tx_to_inclusion_stage(tx.clone()).await {
                    error!(
                        ?err,
                        payload_details = ?tx.payload_details(),
                        "Error sending transaction to inclusion stage"
                    );
                    self.drop_tx(&tx, DropReason::UnhandledError).await;
                    continue;
                } else {
                    self.store_tx(&tx).await;
                }
            }
        }
    }

    async fn drop_payloads(&self, details: &[PayloadDetails], reason: DropReason) {
        for d in details {
            if let Err(err) = self
                .state
                .payload_db
                .store_new_payload_status(d.id(), PayloadStatus::Dropped(reason.clone()))
                .await
            {
                error!(
                    ?err,
                    payload_details = ?details,
                    "Error updating payload status to `dropped`"
                );
            }
            warn!(?details, "Payload dropped from Building Stage");
        }
    }

    async fn drop_tx(&self, tx: &Transaction, reason: DropReason) {
        // Transactions are only persisted if they are sent to the Inclusion Stage
        // so the only thing to update in this stage is the payload status
        self.drop_payloads(tx.payload_details(), reason).await;
    }

    async fn store_tx(&self, tx: &Transaction) {
        if let Err(err) = self.state.tx_db.store_transaction_by_id(tx).await {
            error!(
                ?err,
                payload_details = ?tx.payload_details(),
                "Error storing transaction in the database"
            );
        }
        for payload_detail in tx.payload_details() {
            if let Err(err) = self
                .state
                .payload_db
                .store_new_payload_status(payload_detail.id(), PayloadStatus::PendingInclusion)
                .await
            {
                error!(
                    ?err,
                    payload_details = ?tx.payload_details(),
                    "Error updating payload status to `sent`"
                );
            }

            if let Err(err) = self
                .state
                .payload_db
                .store_tx_id_by_payload_id(payload_detail.id(), tx.id())
                .await
            {
                error!(
                    ?err,
                    payload_details = ?tx.payload_details(),
                    "Error storing transaction id in the database"
                );
            }
        }
    }

    async fn simulate_tx(&self, tx: &Transaction) -> Result<()> {
        match self.state.adapter.simulate_tx(tx).await {
            Ok(true) => {
                info!(?tx, "Transaction simulation succeeded");
                Ok(())
            }
            Ok(false) => Err(eyre::eyre!("Transaction simulation failed")),
            Err(err) => Err(eyre::eyre!("Error simulating transaction: {:?}", err)),
        }
    }

    async fn send_tx_to_inclusion_stage(&self, tx: Transaction) -> Result<()> {
        if let Err(err) = self.inclusion_stage_sender.send(tx.clone()).await {
            return Err(eyre::eyre!(
                "Error sending transaction to Inclusion Stage: {:?}",
                err
            ));
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
        chain_tx_adapter::AdaptsChain,
        payload::{self, FullPayload, PayloadDetails},
        payload_dispatcher::{
            building_stage,
            test_utils::tests::{dummy_tx, tmp_dbs, MockAdapter},
            PayloadDispatcherState,
        },
        transaction::Transaction,
    };

    use super::{BuildingStage, BuildingStageQueue};

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
                let payload_details_received = tx_received.payload_details();
                received_payloads.extend_from_slice(payload_details_received);
            }
            received_payloads
        };

        // give the building stage 1 second to send the transaction(s) to the receiver
        let _ = tokio::select! {
            // this arm runs indefinitely
            res = building_stage.run() => res,
            // this arm runs until all sent payloads are sent as txs
            payloads = received_payloads => {
                return payloads;
            },
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => panic!("Timeout"),
        };
        panic!("No transaction was sent to the receiver")
    }

    fn test_setup(
        payloads_to_send: usize,
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
            .returning(|payloads| Ok(dummy_tx(payloads)));
        mock_adapter
            .expect_simulate_tx()
            .times(payloads_to_send)
            .returning(|_| Ok(true));
        let adapter = Box::new(mock_adapter) as Box<dyn AdaptsChain>;
        let state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
        let (sender, receiver) = tokio::sync::mpsc::channel(100);
        let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
        let building_stage = BuildingStage::new(queue.clone(), sender, state);
        (building_stage, receiver, queue)
    }

    #[tokio::test]
    async fn test_send_payloads_one_by_one() {
        const PAYLOADS_TO_SEND: usize = 3;
        let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND);

        // send a single payload to the building stage and check that it is sent to the receiver
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::default();
            queue.lock().await.push_back(payload_to_send.clone());
            let payload_details_received =
                run_building_stage(1, &building_stage, &mut receiver).await;
            assert_eq!(
                payload_details_received,
                vec![payload_to_send.details().clone()]
            );
        }
    }

    #[tokio::test]
    async fn test_send_multiple_payloads_at_once() {
        const PAYLOADS_TO_SEND: usize = 3;
        let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND);

        let mut sent_payloads = Vec::new();
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = FullPayload::default();
            queue.lock().await.push_back(payload_to_send.clone());
            sent_payloads.push(payload_to_send);
        }

        // send multiple payloads to the building stage and check that they are sent to the receiver in the same order
        let payload_details_received =
            run_building_stage(PAYLOADS_TO_SEND, &building_stage, &mut receiver).await;
        let expected_payload_details = sent_payloads
            .iter()
            .map(|payload| payload.details().clone())
            .collect::<Vec<_>>();
        assert_eq!(payload_details_received, expected_payload_details);
    }
}
