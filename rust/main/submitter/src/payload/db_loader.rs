use std::sync::{mpsc::Sender, Arc};

use async_trait::async_trait;
use tracing::trace;

use crate::{
    chain_tx_adapter::DispatcherError,
    payload_dispatcher::{BuildingStageQueue, LoadableFromDb, LoadingOutcome},
};

use super::{FullPayload, PayloadDb, PayloadStatus};

pub struct PayloadDbLoader {
    db: Arc<dyn PayloadDb>,
    building_stage_queue: BuildingStageQueue,
}

#[async_trait]
impl LoadableFromDb for PayloadDbLoader {
    type Item = FullPayload;

    async fn highest_index(&self) -> Result<u32, DispatcherError> {
        Ok(self.db.retrieve_highest_index().await?)
    }

    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, DispatcherError> {
        Ok(self.db.retrieve_payload_by_index(index).await?)
    }

    async fn load(&self, item: FullPayload) -> Result<LoadingOutcome, DispatcherError> {
        match item.status {
            PayloadStatus::ReadyToSubmit | PayloadStatus::Retry(_) => {
                self.building_stage_queue.lock().await.push_back(item);
                Ok(LoadingOutcome::Loaded)
            }
            PayloadStatus::Dropped(_) | PayloadStatus::InTransaction(_) => {
                trace!(?item, "Payload already processed");
                Ok(LoadingOutcome::Skipped)
            }
        }
    }
}
