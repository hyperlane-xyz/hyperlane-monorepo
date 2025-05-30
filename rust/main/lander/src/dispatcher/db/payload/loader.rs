use std::{
    fmt::{Debug, Formatter},
    sync::{mpsc::Sender, Arc},
};

use async_trait::async_trait;
use derive_new::new;
use tracing::{debug, trace};

use crate::{
    dispatcher::{BuildingStageQueue, DbIterator, LoadableFromDb, LoadingOutcome},
    error::LanderError,
    payload::{FullPayload, PayloadStatus},
};

use super::PayloadDb;

#[derive(new)]
pub struct PayloadDbLoader {
    db: Arc<dyn PayloadDb>,
    building_stage_queue: BuildingStageQueue,
    domain: String,
}

impl PayloadDbLoader {
    pub async fn into_iterator(self) -> DbIterator<Self> {
        let domain = self.domain.clone();
        DbIterator::new(Arc::new(self), "Payload".to_string(), false, domain).await
    }
}

impl Debug for PayloadDbLoader {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PayloadDbLoader").finish()
    }
}

#[async_trait]
impl LoadableFromDb for PayloadDbLoader {
    type Item = FullPayload;

    async fn highest_index(&self) -> Result<u32, LanderError> {
        Ok(self.db.retrieve_highest_index().await?)
    }

    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, LanderError> {
        Ok(self.db.retrieve_payload_by_index(index).await?)
    }

    async fn load(&self, item: FullPayload) -> Result<LoadingOutcome, LanderError> {
        match item.status {
            PayloadStatus::ReadyToSubmit | PayloadStatus::Retry(_) => {
                self.building_stage_queue.lock().await.push_back(item);
                Ok(LoadingOutcome::Loaded)
            }
            PayloadStatus::Dropped(_) | PayloadStatus::InTransaction(_) => {
                debug!(?item, "Payload already processed");
                Ok(LoadingOutcome::Skipped)
            }
        }
    }
}
