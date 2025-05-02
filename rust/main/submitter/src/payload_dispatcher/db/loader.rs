// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::cmp::max;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use hyperlane_base::db::HyperlaneDb;

use async_trait::async_trait;
use hyperlane_base::db::DbResult;
use tokio::time::sleep;
use tracing::{debug, info, instrument};

use crate::error::SubmitterError;
use crate::payload_dispatcher::metrics::DispatcherMetrics;

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
pub struct DbIterator<T> {
    low_index_iter: DirectionalIndexIterator<T>,
    high_index_iter: Option<DirectionalIndexIterator<T>>,
    iterated_item_name: String,
    domain: String,
}

impl<T: LoadableFromDb + Debug> DbIterator<T> {
    #[instrument(skip(loader), ret)]
    pub async fn new(
        loader: Arc<T>,
        iterated_item_name: String,
        only_load_backward: bool,
        domain: String,
    ) -> Self {
        // the db returns 0 if uninitialized
        let high_index = max(loader.highest_index().await.unwrap_or_default(), 1);
        let mut low_index_iter = DirectionalIndexIterator::new(
            high_index,
            IndexDirection::Low,
            loader.clone(),
            iterated_item_name.clone(),
        );
        let high_index_iter = if only_load_backward {
            None
        } else {
            let high_index_iter = DirectionalIndexIterator::new(
                // If the high nonce is None, we start from the beginning
                high_index,
                IndexDirection::High,
                loader,
                iterated_item_name.clone(),
            );
            // Decrement the low index to avoid processing the same index twice
            low_index_iter.iterate();
            Some(high_index_iter)
        };

        debug!(
            ?low_index_iter,
            ?high_index_iter,
            ?iterated_item_name,
            "Initialized ForwardBackwardIterator"
        );
        Self {
            low_index_iter,
            high_index_iter,
            iterated_item_name,
            domain,
        }
    }

    async fn try_load_next_item(&mut self) -> Result<LoadingOutcome, SubmitterError> {
        // Always prioritize advancing the the high nonce iterator, as
        // we have a preference for higher nonces
        if let Some(high_index_iter) = &mut self.high_index_iter {
            match high_index_iter.try_load_item().await? {
                Some(LoadingOutcome::Loaded) => {
                    high_index_iter.iterate();
                    // If we have a high nonce item, we can process it
                    return Ok(LoadingOutcome::Loaded);
                }
                Some(LoadingOutcome::Skipped) => {
                    high_index_iter.iterate();
                }
                None => {}
            }
        }

        // Low nonce messages are only processed if the high nonce iterator
        // can't make any progress
        match self.low_index_iter.try_load_item().await? {
            Some(LoadingOutcome::Loaded) => {
                // If we have a low nonce item, we can process it
                self.low_index_iter.iterate();
                return Ok(LoadingOutcome::Loaded);
            }
            Some(LoadingOutcome::Skipped) => {
                // If we don't have any items, we can skip
                self.low_index_iter.iterate();
            }
            None => {}
        }
        Ok(LoadingOutcome::Skipped)
    }

    pub async fn load_from_db(&mut self, metrics: DispatcherMetrics) -> Result<(), SubmitterError> {
        loop {
            metrics.update_liveness_metric(
                format!("{}DbLoader", self.iterated_item_name,).as_str(),
                self.domain.as_str(),
            );
            if let LoadingOutcome::Skipped = self.try_load_next_item().await? {
                if self.high_index_iter.is_none() {
                    debug!(?self, "No more items to process, stopping iterator",);
                    // If we are only loading backward, we have processed all items
                    return Ok(());
                }
                debug!(?self, "No items to process, sleeping for a bit");
                // sleep to wait for new items to be added
                sleep(Duration::from_millis(100)).await;
            } else {
                debug!(?self, "Loaded item");
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
    index: u32,
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
                self.index = self.index.saturating_add(1);
                debug!(?self, "Iterating high nonce");
            }
            IndexDirection::Low => {
                if self.index == 0 {
                    // If we are at the beginning, we can't go lower
                    return;
                }
                self.index = self.index.saturating_sub(1);
                debug!(?self, "Iterating low nonce");
            }
        }
    }

    async fn try_load_item(&self) -> Result<Option<LoadingOutcome>, SubmitterError> {
        let Some(item) = self.loader.retrieve_by_index(self.index).await? else {
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
            DbIterator::new(
                db.clone(),
                metadata.clone(),
                only_load_backward,
                "test_domain".to_string(),
            )
            .await,
            db,
        )
    }

    #[tokio::test]
    async fn test_db_iterator_forward_backward() {
        let only_load_backward = false;
        let num_db_insertions = 2;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        assert_eq!(iterator.low_index_iter.index, 1);
        assert_eq!(iterator.high_index_iter.as_ref().unwrap().index, 2);
        iterator.try_load_next_item().await.unwrap();
        assert_eq!(iterator.low_index_iter.index, 1);
        assert_eq!(iterator.high_index_iter.unwrap().index, 3);
    }

    #[tokio::test]
    async fn test_db_iterator_only_backward() {
        let only_load_backward = true;
        let num_db_insertions = 2;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        assert_eq!(iterator.low_index_iter.index, 2);
        assert!(iterator.high_index_iter.is_none());
        iterator.try_load_next_item().await.unwrap();
        assert_eq!(iterator.low_index_iter.index, 1);
        assert!(iterator.high_index_iter.is_none());
    }

    #[tokio::test]
    async fn test_load_from_db_finishes_if_only_loading_backward() {
        let only_load_backward = true;
        let num_db_insertions = 5;
        let (mut iterator, _) = set_up_state(only_load_backward, num_db_insertions).await;

        iterator
            .load_from_db(DispatcherMetrics::dummy_instance())
            .await
            .unwrap();
        assert_eq!(iterator.low_index_iter.index, 0);
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
            _ = iterator.load_from_db(DispatcherMetrics::dummy_instance()) => {
                panic!("Loading from db finished although the high iterator should've kept waiting for new items");
            }
            _ = first_assertion_and_state_change => {
            }
        };

        assert_eq!(iterator.low_index_iter.index, 0);
        assert_eq!(
            iterator.high_index_iter.as_ref().unwrap().index,
            num_db_insertions + 2
        );
    }
}
