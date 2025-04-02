use std::fmt::{Debug, Formatter};
use std::sync::Arc;

use derive_new::new;
use hyperlane_base::db::HyperlaneDb;

use async_trait::async_trait;
use hyperlane_base::db::DbResult;
use tracing::{debug, instrument};

use crate::chain_tx_adapter::DispatcherError;

#[async_trait]
pub trait LoadableFromDb {
    type Item: Sized;

    async fn highest_index(&self) -> Result<u32, DispatcherError>;
    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, DispatcherError>;
    async fn load(&self, item: Self::Item) -> Result<LoadingOutcome, DispatcherError>;
}

pub enum LoadingOutcome {
    Loaded,
    Skipped,
}

#[derive(Debug)]
struct DbIterator<T> {
    low_index_iter: DirectionalIndexIterator<T>,
    high_index_iter: DirectionalIndexIterator<T>,
    // here for debugging purposes
    _metadata: String,
}

impl<T: LoadableFromDb + Debug> DbIterator<T> {
    #[instrument(skip(loader), ret)]
    async fn new(loader: Arc<T>, metadata: String) -> Self {
        let high_index = loader.highest_index().await.ok();
        let high_index_iter = DirectionalIndexIterator::new(
            // If the high nonce is None, we start from the beginning
            high_index.unwrap_or_default().into(),
            IndexDirection::High,
            loader.clone(),
            metadata.clone(),
        );
        let mut low_index_iter = DirectionalIndexIterator::new(
            high_index,
            IndexDirection::Low,
            loader,
            metadata.clone(),
        );
        // Decrement the low index to avoid processing the same index
        low_index_iter.iterate();
        debug!(
            ?low_index_iter,
            ?high_index_iter,
            ?metadata,
            "Initialized ForwardBackwardIterator"
        );
        Self {
            low_index_iter,
            high_index_iter,
            _metadata: metadata,
        }
    }

    async fn try_load_next_item(&mut self) -> Result<(), DispatcherError> {
        // Always prioritize advancing the the high nonce iterator, as
        // we have a preference for higher nonces
        if let Some(LoadingOutcome::Loaded) = self.high_index_iter.try_load_item().await? {
            // If we have a high nonce item, we can process it
            self.high_index_iter.iterate();
            return Ok(());
        }
        // Low nonce messages are only processed if the high nonce iterator
        // can't make any progress
        if let Some(LoadingOutcome::Loaded) = self.low_index_iter.try_load_item().await? {
            // If we have a low nonce item, we can process it
            self.low_index_iter.iterate();
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
enum IndexDirection {
    #[default]
    High,
    Low,
}

#[derive(new)]
struct DirectionalIndexIterator<T> {
    index: Option<u32>,
    direction: IndexDirection,
    loader: Arc<T>,
    _metadata: String,
}

impl<T: Debug> Debug for DirectionalIndexIterator<T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DirectionalNonceIterator {{ index: {:?}, direction: {:?}, metadata: {:?} }}",
            self.index, self.direction, self._metadata
        )
    }
}

impl<T: LoadableFromDb + Debug> DirectionalIndexIterator<T> {
    #[instrument]
    fn iterate(&mut self) {
        match self.direction {
            IndexDirection::High => {
                self.index = self.index.map(|n| n.saturating_add(1));
                debug!(?self, "Iterating high nonce");
            }
            IndexDirection::Low => {
                if let Some(index) = self.index {
                    // once the index zero is processed, stop going backwards
                    self.index = index.checked_sub(1);
                }
            }
        }
    }

    async fn try_load_item(&self) -> Result<Option<LoadingOutcome>, DispatcherError> {
        let Some(index) = self.index else {
            return Ok(None);
        };
        let Some(item) = self.loader.retrieve_by_index(index).await? else {
            return Ok(None);
        };
        Ok(Some(self.loader.load(item).await?))
    }
}
