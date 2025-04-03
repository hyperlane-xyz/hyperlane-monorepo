// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use hyperlane_base::db::HyperlaneDb;

use async_trait::async_trait;
use hyperlane_base::db::DbResult;
use tokio::time::sleep;
use tracing::{debug, instrument};

use crate::error::SubmitterError;

#[async_trait]
pub trait LoadableFromDb {
    type Item: Sized;

    async fn highest_index(&self) -> Result<u32, SubmitterError>;
    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, SubmitterError>;
    async fn load(&self, item: Self::Item) -> Result<LoadingOutcome, SubmitterError>;
}

pub enum LoadingOutcome {
    Loaded,
    Skipped,
}

#[derive(Debug)]
struct DbIterator<T> {
    low_index_iter: DirectionalIndexIterator<T>,
    high_index_iter: Option<DirectionalIndexIterator<T>>,
    // here for debugging purposes
    _metadata: String,
}

impl<T: LoadableFromDb + Debug> DbIterator<T> {
    #[instrument(skip(loader), ret)]
    async fn new(loader: Arc<T>, metadata: String, only_load_backward: bool) -> Self {
        let high_index = loader.highest_index().await.ok();
        let mut low_index_iter = DirectionalIndexIterator::new(
            high_index,
            IndexDirection::Low,
            loader.clone(),
            metadata.clone(),
        );
        let high_index_iter = if only_load_backward {
            None
        } else {
            let high_index_iter = DirectionalIndexIterator::new(
                // If the high nonce is None, we start from the beginning
                high_index.unwrap_or_default().into(),
                IndexDirection::High,
                loader,
                metadata.clone(),
            );
            // Decrement the low index to avoid processing the same index twice
            low_index_iter.iterate();
            Some(high_index_iter)
        };

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

    async fn try_load_next_item(&mut self) -> Result<LoadingOutcome, SubmitterError> {
        // Always prioritize advancing the the high nonce iterator, as
        // we have a preference for higher nonces
        if let Some(high_index_iter) = &mut self.high_index_iter {
            if let Some(LoadingOutcome::Loaded) = high_index_iter.try_load_item().await? {
                // If we have a high nonce item, we can process it
                high_index_iter.iterate();
                return Ok(LoadingOutcome::Loaded);
            }
        }

        // Low nonce messages are only processed if the high nonce iterator
        // can't make any progress
        if let Some(LoadingOutcome::Loaded) = self.low_index_iter.try_load_item().await? {
            // If we have a low nonce item, we can process it
            self.low_index_iter.iterate();
            return Ok(LoadingOutcome::Loaded);
        }
        Ok(LoadingOutcome::Skipped)
    }

    pub async fn load_from_db(&mut self) -> Result<(), SubmitterError> {
        loop {
            if let LoadingOutcome::Skipped = self.try_load_next_item().await? {
                if self.high_index_iter.is_none() {
                    // If we are only loading backward, we have processed all items
                    return Ok(());
                }
                // sleep to wait for new items to be added
                sleep(Duration::from_secs(1)).await;
            }
        }
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

    async fn try_load_item(&self) -> Result<Option<LoadingOutcome>, SubmitterError> {
        let Some(index) = self.index else {
            return Ok(None);
        };
        let Some(item) = self.loader.retrieve_by_index(index).await? else {
            return Ok(None);
        };
        Ok(Some(self.loader.load(item).await?))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use solana_sdk::nonce::state;
    use tokio::sync::Mutex;

    use super::*;

    #[derive(Debug, Clone)]
    struct MockDbState {
        data: HashMap<u32, String>,
        highest_index: u32,
    }

    #[derive(Debug, Clone)]
    struct MockDb {
        state: Arc<Mutex<MockDbState>>,
    }

    impl MockDb {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(MockDbState {
                    data: HashMap::new(),
                    highest_index: 0,
                })),
            }
        }
    }

    #[async_trait]
    impl LoadableFromDb for MockDb {
        type Item = String;

        async fn highest_index(&self) -> Result<u32, SubmitterError> {
            let state = self.state.lock().await;
            Ok(state.highest_index)
        }

        async fn retrieve_by_index(
            &self,
            index: u32,
        ) -> Result<Option<Self::Item>, SubmitterError> {
            let state = self.state.lock().await;
            Ok(state.data.get(&index).cloned())
        }

        async fn load(&self, item: Self::Item) -> Result<LoadingOutcome, SubmitterError> {
            debug!("Loading item: {:?}", item);
            Ok(LoadingOutcome::Loaded)
        }
    }

    async fn set_up_state(
        only_load_backward: bool,
        num_items: usize,
    ) -> (DbIterator<MockDb>, Arc<MockDb>) {
        let db = Arc::new(MockDb::new());
        let metadata = "Test Metadata".to_string();

        // Simulate adding items to the database
        {
            let mut state = db.state.lock().await;

            for i in 1..=num_items {
                state.data.insert(i as u32, format!("Item {}", i));
            }
            state.highest_index = num_items as u32;
        }
        (
            DbIterator::new(db.clone(), metadata.clone(), only_load_backward).await,
            db,
        )
    }

    #[tokio::test]
    async fn test_db_iterator_forward_backward() {
        let only_load_backward = false;
        let num_db_insertions = 2;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        assert_eq!(*iterator.low_index_iter.index.as_ref().unwrap(), 1);
        assert_eq!(
            *iterator
                .high_index_iter
                .as_ref()
                .unwrap()
                .index
                .as_ref()
                .unwrap(),
            2
        );
        iterator.try_load_next_item().await.unwrap();
        assert_eq!(iterator.low_index_iter.index, Some(1));
        assert_eq!(iterator.high_index_iter.unwrap().index, Some(3));
    }

    #[tokio::test]
    async fn test_db_iterator_only_backward() {
        let only_load_backward = true;
        let num_db_insertions = 2;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        assert_eq!(*iterator.low_index_iter.index.as_ref().unwrap(), 2);
        assert!(iterator.high_index_iter.is_none());
        iterator.try_load_next_item().await.unwrap();
        assert_eq!(*iterator.low_index_iter.index.as_ref().unwrap(), 1);
        assert!(iterator.high_index_iter.is_none());
    }

    #[tokio::test]
    async fn test_load_from_db_finishes_if_only_loading_backward() {
        let only_load_backward = true;
        let num_db_insertions = 5;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        iterator.load_from_db().await.unwrap();
        assert_eq!(*iterator.low_index_iter.index.as_ref().unwrap(), 0);
        assert!(iterator.high_index_iter.is_none());
    }

    #[tokio::test]
    async fn test_load_from_db_keeps_running_if_forward_backward() {
        let only_load_backward = false;
        let num_db_insertions: u32 = 5;
        let (mut iterator, db) = set_up_state(only_load_backward, num_db_insertions as usize).await;
        // this future is used to assert that the iterator keeps running
        // and doesn't finish loading from the db
        let first_assertion_and_state_change = async {
            sleep(Duration::from_millis(100)).await;
            {
                let mut state = db.state.lock().await;
                let new_num_db_insertions = num_db_insertions + 1;
                state.data.insert(
                    (new_num_db_insertions) as u32,
                    format!("Item {}", new_num_db_insertions),
                );
                state.highest_index = new_num_db_insertions as u32;
            }

            // now sleep for a bit to let the iterator process the new item
            sleep(Duration::from_millis(1100)).await;
        };

        tokio::select! {
            _ = iterator.load_from_db() => {
                panic!("Loading from db finished although the high iterator should've kept waiting for new items");
            }
            _ = first_assertion_and_state_change => {
            }
        };

        assert_eq!(*iterator.low_index_iter.index.as_ref().unwrap(), 0);
        assert_eq!(
            *iterator
                .high_index_iter
                .as_ref()
                .unwrap()
                .index
                .as_ref()
                .unwrap(),
            num_db_insertions + 2
        );
    }
}
