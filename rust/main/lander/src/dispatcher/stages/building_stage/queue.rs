mod tests;

use std::collections::VecDeque;
use std::ops::Deref;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::FullPayload;

#[derive(Debug, Clone)]
pub struct BuildingStageQueue(Arc<Mutex<VecDeque<FullPayload>>>);

impl BuildingStageQueue {
    pub fn new() -> Self {
        BuildingStageQueue(Arc::new(Mutex::new(VecDeque::new())))
    }

    /// Push a payload to the back of the queue.
    pub async fn push_back(&self, payload: FullPayload) {
        self.0.lock().await.push_back(payload);
    }

    /// Push a payload to the front of the queue.
    pub async fn push_front(&self, payload: FullPayload) {
        self.0.lock().await.push_front(payload);
    }

    /// Extend the queue with an iterator of payloads.
    pub async fn extend<I: IntoIterator<Item = FullPayload>>(&self, iter: I) {
        self.0.lock().await.extend(iter);
    }

    /// Pops up to `count` payloads from the front of the queue.
    pub async fn pop_n(&self, count: usize) -> Vec<FullPayload> {
        let mut queue = self.0.lock().await;
        let mut result = Vec::with_capacity(count);
        for _ in 0..count {
            if let Some(payload) = queue.pop_front() {
                result.push(payload);
            } else {
                break;
            }
        }
        result
    }

    /// Get the length of the queue.
    pub async fn len(&self) -> usize {
        self.0.lock().await.len()
    }
}
