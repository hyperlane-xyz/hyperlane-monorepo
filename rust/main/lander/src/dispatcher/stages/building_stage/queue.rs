use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
};

use hyperlane_core::identifiers::UniqueIdentifier;
use tokio::sync::{Mutex, Notify};

use crate::{FullPayload, PayloadUuid};

#[derive(Debug, Clone)]
pub struct BuildingStageQueue {
    inner: Arc<Mutex<QueueInner>>,
    activity: Arc<Notify>,
}

#[derive(Debug, Default)]
struct QueueInner {
    payloads: VecDeque<FullPayload>,
    uuids: HashSet<PayloadUuid>,
}

impl BuildingStageQueue {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(QueueInner::default())),
            activity: Arc::new(Notify::new()),
        }
    }

    /// Push a payload to the back of the queue.
    pub async fn push_back(&self, payload: FullPayload) {
        let mut inner = self.inner.lock().await;
        if inner.uuids.insert(payload.uuid().clone()) {
            inner.payloads.push_back(payload);
            drop(inner);
            self.activity.notify_one();
        }
    }

    /// Push a payload to the front of the queue.
    pub async fn push_front(&self, payload: FullPayload) {
        let mut inner = self.inner.lock().await;
        if inner.uuids.insert(payload.uuid().clone()) {
            inner.payloads.push_front(payload);
            drop(inner);
            self.activity.notify_one();
        }
    }

    /// Extend the queue with an iterator of payloads.
    pub async fn extend<I: IntoIterator<Item = FullPayload>>(&self, iter: I) {
        let mut inner = self.inner.lock().await;
        let mut added = false;
        for payload in iter {
            if inner.uuids.insert(payload.uuid().clone()) {
                inner.payloads.push_back(payload);
                added = true;
            }
        }
        drop(inner);
        if added {
            self.activity.notify_one();
        }
    }

    /// Pops up to `count` payloads from the front of the queue.
    pub async fn pop_n(&self, count: usize) -> Vec<FullPayload> {
        let mut inner = self.inner.lock().await;
        let mut result = Vec::with_capacity(count);
        for _ in 0..count {
            if let Some(payload) = inner.payloads.pop_front() {
                inner.uuids.remove(payload.uuid());
                result.push(payload);
            } else {
                break;
            }
        }
        result
    }

    /// Wait for activity and pop up to `count` payloads.
    pub async fn pop_n_or_wait(&self, count: usize) -> Vec<FullPayload> {
        loop {
            let payloads = self.pop_n(count).await;
            if !payloads.is_empty() {
                return payloads;
            }
            self.activity.notified().await;
        }
    }

    /// Get the length of the queue.
    pub async fn len(&self) -> usize {
        self.inner.lock().await.payloads.len()
    }
}

#[cfg(test)]
mod tests;
