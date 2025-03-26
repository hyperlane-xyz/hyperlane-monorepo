// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::sync::{mpsc, Mutex};

use crate::{payload::FullPayload, transaction::Transaction};

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
    pub async fn run(&self) -> Result<()> {
        loop {
            let payload = self.queue.lock().await.pop_front();
            if let Some(payload) = payload {
                let txs = self.state.adapter.build_transactions(vec![payload]).await?;
                for tx in txs {
                    self.inclusion_stage_sender.send(tx).await?;
                }
            } else {
                // wait for the next payload to arrive
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use eyre::Result;
    use std::{collections::VecDeque, sync::Arc};

    use crate::{
        chain_tx_adapter::AdaptsChain,
        payload::{self, PayloadDetails},
        payload_dispatcher::{
            building_stage,
            test_utils::tests::{dummy_tx, tmp_dbs, MockAdapter},
        },
        transaction::Transaction,
    };

    use super::{BuildingStage, BuildingStageQueue};

    async fn run_building_stage_once(
        building_stage: &super::BuildingStage,
        receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
    ) -> Result<PayloadDetails> {
        // give the building stage 1 second to send the transaction to the receiver
        let _ = tokio::select! {
            // this arm runs indefinitely
            res = building_stage.run() => res,
            // this arm runs until the first transaction is created by the step above
            tx = receiver.recv() => {
                return Ok(tx.unwrap().payload_details().first().unwrap().clone());
            },
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => Err(eyre::eyre!("Timeout")),
        }?;
        Err(eyre::eyre!("No transaction was sent to the receiver"))
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
        let adapter = Box::new(mock_adapter) as Box<dyn AdaptsChain>;
        let state = super::PayloadDispatcherState::new(payload_db, tx_db, adapter);
        let (sender, receiver) = tokio::sync::mpsc::channel(100);
        let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
        let building_stage = super::BuildingStage::new(queue.clone(), sender, state);
        (building_stage, receiver, queue)
    }

    #[tokio::test]
    async fn test_send_payloads_one_by_one() {
        const PAYLOADS_TO_SEND: usize = 3;
        let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND);

        // send a single payload to the building stage and check that it is sent to the receiver
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = super::FullPayload::default();
            queue.lock().await.push_back(payload_to_send.clone());
            let payload_details_received = run_building_stage_once(&building_stage, &mut receiver)
                .await
                .unwrap();
            assert_eq!(payload_details_received, payload_to_send.details());
        }
    }

    #[tokio::test]
    async fn test_send_multiple_payloads_at_once() {
        const PAYLOADS_TO_SEND: usize = 3;
        let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND);

        let mut sent_payloads = Vec::new();
        for _ in 0..PAYLOADS_TO_SEND {
            let payload_to_send = super::FullPayload::default();
            queue.lock().await.push_back(payload_to_send.clone());
            sent_payloads.push(payload_to_send);
        }

        // send multiple payloads to the building stage and check that they are sent to the receiver in the same order
        for sent_payload in sent_payloads {
            let payload_details_received = run_building_stage_once(&building_stage, &mut receiver)
                .await
                .unwrap();
            assert_eq!(payload_details_received, sent_payload.details());
        }
    }
}
