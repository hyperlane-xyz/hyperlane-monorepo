use std::{collections::VecDeque, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::sync::{mpsc, Mutex};

use crate::{payload::FullPayload, transaction::Transaction};

use super::StageState;

pub type BuildingStageQueue = Arc<Mutex<VecDeque<FullPayload>>>;

// spawn the 3 stages using the adapter, db, queue and channels

#[derive(new)]
struct BuildingStage {
    /// This queue is the entrypoint and event driver of the Building Stage
    queue: BuildingStageQueue,
    /// This channel is the exitpoint of the Building Stage
    inclusion_stage_channel: mpsc::Sender<Transaction>,
    state: StageState,
}

impl BuildingStage {
    pub async fn run(&self) -> Result<()> {
        loop {
            let payload = self.queue.lock().await.pop_front();
            if let Some(payload) = payload {
                let txs = self.state.adapter.build_transactions(vec![payload]).await?;
                for tx in txs {
                    self.inclusion_stage_channel.send(tx).await.unwrap();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Arc};

    use crate::{
        chain_tx_adapter::AdaptsChain,
        payload_dispatcher::test_utils::tests::{tmp_dbs, MockAdapter},
    };

    #[tokio::test]
    async fn test_full_stage_run() {
        let (payload_db, tx_db) = tmp_dbs();
        let adapter = Box::new(MockAdapter::new()) as Box<dyn AdaptsChain>;
        let state = super::StageState::new(payload_db, tx_db, adapter);
        let (tx_sender, _) = tokio::sync::mpsc::channel(100);
        let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));
        let payload = super::FullPayload::default();
        queue.lock().await.push_back(payload);
        let building_stage = super::BuildingStage::new(queue, tx_sender, state);
        building_stage.run().await;
    }
}
