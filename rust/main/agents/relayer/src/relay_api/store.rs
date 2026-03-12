use super::job::RelayJob;
use eyre::Result;
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::{task::JoinHandle, time};
use tracing::{debug, info};
use uuid::Uuid;

#[derive(Clone)]
pub struct JobStore {
    jobs: Arc<RwLock<HashMap<Uuid, RelayJob>>>,
}

impl JobStore {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn insert(&self, job: RelayJob) -> Uuid {
        let job_id = job.id;
        let mut jobs = self.jobs.write().unwrap();
        jobs.insert(job_id, job);
        debug!(job_id = %job_id, "Inserted relay job");
        job_id
    }

    pub fn get(&self, id: &Uuid) -> Option<RelayJob> {
        let jobs = self.jobs.read().unwrap();
        jobs.get(id).cloned()
    }

    pub fn update(&self, job: RelayJob) {
        let mut jobs = self.jobs.write().unwrap();
        if jobs.contains_key(&job.id) {
            debug!(job_id = %job.id, status = ?job.status, "Updated relay job");
            jobs.insert(job.id, job);
        }
    }

    pub fn remove(&self, id: &Uuid) -> Option<RelayJob> {
        let mut jobs = self.jobs.write().unwrap();
        jobs.remove(id)
    }

    pub fn remove_expired(&self) -> usize {
        let mut jobs = self.jobs.write().unwrap();
        let expired: Vec<Uuid> = jobs
            .iter()
            .filter(|(_, job)| job.is_expired())
            .map(|(id, _)| *id)
            .collect();

        let count = expired.len();
        for id in expired {
            jobs.remove(&id);
        }

        if count > 0 {
            info!(count, "Removed expired relay jobs");
        }
        count
    }

    pub fn len(&self) -> usize {
        let jobs = self.jobs.read().unwrap();
        jobs.len()
    }

    pub fn spawn_cleanup_task(self, cleanup_interval: Duration) -> JoinHandle<Result<()>> {
        tokio::spawn(async move {
            let mut interval = time::interval(cleanup_interval);
            loop {
                interval.tick().await;
                self.remove_expired();
            }
        })
    }
}

impl Default for JobStore {
    fn default() -> Self {
        Self::new()
    }
}
