// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::sync::{mpsc, Mutex};

use crate::{payload::FullPayload, transaction::Transaction};

use super::StageState;

pub type BuildingStageQueue = Arc<Mutex<VecDeque<FullPayload>>>;

#[derive(new)]
struct BuildingStage {
    /// This queue is the entrypoint and event driver of the Building Stage
    queue: BuildingStageQueue,
    /// This channel is the exitpoint of the Building Stage
    inclusion_stage_sender: mpsc::Sender<Transaction>,
    state: StageState,
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
        payload,
        payload_dispatcher::{
            building_stage,
            test_utils::tests::{dummy_tx, tmp_dbs, MockAdapter},
        },
        transaction::Transaction,
    };

    async fn run_building_stage_once(
        building_stage: &super::BuildingStage,
        payload: payload::FullPayload,
        receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
        queue: &super::BuildingStageQueue,
    ) -> Result<()> {
        queue.lock().await.push_back(payload.clone());

        // give the building stage 1 second to send the transaction to the receiver
        let _ = tokio::select! {
            res = building_stage.run() => res,
            tx = receiver.recv() => {
                assert_eq!(tx.unwrap().payload_details(), vec![payload.details()]);
                Ok(())
            },
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => Err(eyre::eyre!("Timeout")),
        }?;
        Ok(())
    }

    #[tokio::test]
    async fn test_full_stage_run() {
        const PAYLOADS_TO_SEND: usize = 3;
        let (payload_db, tx_db) = tmp_dbs();
        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_build_transactions()
            .times(PAYLOADS_TO_SEND)
            .returning(|payloads| Ok(dummy_tx(payloads)));

        let adapter = Box::new(mock_adapter) as Box<dyn AdaptsChain>;
        let state = super::StageState::new(payload_db, tx_db, adapter);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(100);
        let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
        let building_stage = super::BuildingStage::new(queue.clone(), sender.clone(), state);

        for _ in 0..PAYLOADS_TO_SEND {
            let payload = super::FullPayload::default();
            run_building_stage_once(&building_stage, payload, &mut receiver, &queue)
                .await
                .unwrap();
        }
    }
}
