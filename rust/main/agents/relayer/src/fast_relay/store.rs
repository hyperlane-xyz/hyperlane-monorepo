use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use eyre::Result;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::{debug, info};
use uuid::Uuid;

use super::job::FastRelayJob;

/// In-memory store for fast relay jobs with automatic expiration
#[derive(Clone)]
pub struct JobStore {
    jobs: Arc<RwLock<HashMap<Uuid, FastRelayJob>>>,
}

impl JobStore {
    /// Create a new job store
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Insert a new job
    pub async fn insert(&self, job: FastRelayJob) -> Uuid {
        let id = job.id;
        let mut jobs = self.jobs.write().await;
        jobs.insert(id, job);
        debug!(job_id = ?id, "Inserted fast relay job");
        id
    }

    /// Get a job by ID
    pub async fn get(&self, id: &Uuid) -> Option<FastRelayJob> {
        let jobs = self.jobs.read().await;
        jobs.get(id).cloned()
    }

    /// Update a job
    pub async fn update(&self, job: FastRelayJob) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job.id, job);
    }

    /// Remove a job by ID
    pub async fn remove(&self, id: &Uuid) -> Option<FastRelayJob> {
        let mut jobs = self.jobs.write().await;
        jobs.remove(id)
    }

    /// Get count of jobs
    pub async fn count(&self) -> usize {
        let jobs = self.jobs.read().await;
        jobs.len()
    }

    /// Remove all expired jobs
    pub async fn cleanup_expired(&self) -> usize {
        let mut jobs = self.jobs.write().await;
        let initial_count = jobs.len();

        jobs.retain(|id, job| {
            if job.is_expired() {
                debug!(job_id = ?id, "Removing expired job");
                false
            } else {
                true
            }
        });

        let removed_count = initial_count - jobs.len();
        if removed_count > 0 {
            info!(removed = removed_count, remaining = jobs.len(), "Cleaned up expired jobs");
        }

        removed_count
    }

    /// Spawn a background task to periodically clean up expired jobs
    pub fn spawn_cleanup_task(self, cleanup_interval: Duration) -> JoinHandle<Result<()>> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(cleanup_interval);
            loop {
                interval.tick().await;
                self.cleanup_expired().await;
            }
        })
    }
}

impl Default for JobStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::H256;

    #[tokio::test]
    async fn test_insert_and_get() {
        let store = JobStore::new();
        let job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            3600,
        );
        let id = job.id;

        store.insert(job.clone()).await;
        let retrieved = store.get(&id).await;

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, id);
    }

    #[tokio::test]
    async fn test_update() {
        let store = JobStore::new();
        let mut job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            3600,
        );
        let id = job.id;

        store.insert(job.clone()).await;

        job.update_status(super::super::job::RelayStatus::Preparing);
        store.update(job.clone()).await;

        let retrieved = store.get(&id).await.unwrap();
        assert_eq!(retrieved.status, super::super::job::RelayStatus::Preparing);
    }

    #[tokio::test]
    async fn test_remove() {
        let store = JobStore::new();
        let job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            3600,
        );
        let id = job.id;

        store.insert(job).await;
        assert_eq!(store.count().await, 1);

        store.remove(&id).await;
        assert_eq!(store.count().await, 0);
    }

    #[tokio::test]
    async fn test_cleanup_expired() {
        let store = JobStore::new();

        // Insert expired job
        let expired_job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            0, // Already expired
        );
        store.insert(expired_job).await;

        // Insert valid job
        let valid_job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            3600,
        );
        store.insert(valid_job).await;

        assert_eq!(store.count().await, 2);

        let removed = store.cleanup_expired().await;
        assert_eq!(removed, 1);
        assert_eq!(store.count().await, 1);
    }
}
