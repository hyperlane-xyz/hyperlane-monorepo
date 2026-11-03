use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::{
    collections::HashMap,
    fmt::Debug,
    path::PathBuf,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::Value;

use hyperlane_core::ChainResult;

use crate::{provider::HttpClient, HyperlaneAleoError};

/// A simple mock Http client which allows registering endpoint responses.
/// It can load JSON from files located relative to a base path (e.g. inside src/provider/mock_responses/).
#[derive(Clone, Debug)]
pub struct MockHttpClient {
    base_path: PathBuf,
    // Map from endpoint path (e.g. "block/1") to a serde_json::Value response body
    responses: Arc<RwLock<HashMap<String, Value>>>,
    recording: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
}

struct ActiveRequest(Arc<AtomicUsize>);

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl MockHttpClient {
    pub fn new(base_path: PathBuf) -> Self {
        Self {
            base_path,
            responses: Arc::new(RwLock::new(HashMap::new())),
            recording: Arc::default(),
            active: Arc::default(),
            peak: Arc::default(),
            calls: Arc::default(),
        }
    }

    pub fn record_concurrency(&self) {
        self.recording.store(true, Ordering::SeqCst);
    }

    pub fn concurrency_stats(&self) -> (usize, usize, usize) {
        (
            self.calls.load(Ordering::SeqCst),
            self.peak.load(Ordering::SeqCst),
            self.active.load(Ordering::SeqCst),
        )
    }

    async fn track_request(&self) -> Option<ActiveRequest> {
        if !self.recording.load(Ordering::SeqCst) {
            return None;
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst).saturating_add(1);
        self.peak.fetch_max(active, Ordering::SeqCst);
        let guard = ActiveRequest(self.active.clone());
        tokio::task::yield_now().await;
        Some(guard)
    }

    /// Register a JSON value directly for an endpoint path.
    pub fn register_value(&self, endpoint: impl Into<String>, value: impl Into<Value>) {
        self.responses
            .write()
            .unwrap()
            .insert(endpoint.into(), value.into());
    }

    /// Register a file (json) for an endpoint. File path is relative to base_path.
    pub fn register_file(
        &self,
        endpoint: impl Into<String>,
        relative_file: impl Into<PathBuf>,
    ) -> ChainResult<()> {
        let file = self.base_path.join(relative_file.into());
        let data = std::fs::read_to_string(&file).map_err(|e| {
            HyperlaneAleoError::Other(format!("Failed reading mock file {file:?}: {e}"))
        })?;
        let json: Value = if data.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&data).map_err(HyperlaneAleoError::from)?
        };
        self.register_value(endpoint, json);
        Ok(())
    }

    fn get(&self, path: &str) -> ChainResult<Value> {
        self.responses
            .read()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| {
                HyperlaneAleoError::Other(format!(
                    "No mock response registered for endpoint: {path}"
                ))
            })
            .map(Ok)?
    }
}

#[async_trait]
impl HttpClient for MockHttpClient {
    async fn request<T: DeserializeOwned>(
        &self,
        path: &str,
        _query: impl Into<Option<Value>> + Send,
    ) -> ChainResult<T> {
        let _active = self.track_request().await;
        let path = path
            .trim()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>();
        let value = self.get(&path)?;
        let parsed: T = serde_json::from_value(value).map_err(HyperlaneAleoError::from)?;
        Ok(parsed)
    }

    async fn request_optional<T: DeserializeOwned>(
        &self,
        path: &str,
        _query: impl Into<Option<Value>> + Send,
    ) -> ChainResult<Option<T>> {
        let _active = self.track_request().await;
        let path = path
            .trim()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>();
        let value = {
            let responses = self.responses.read().map_err(|err| {
                HyperlaneAleoError::Other(format!("Mock response lock poisoned: {err}"))
            })?;
            responses.get(&path).cloned()
        };
        let Some(value) = value else {
            return Ok(None);
        };
        let parsed: T = serde_json::from_value(value).map_err(HyperlaneAleoError::from)?;
        Ok(Some(parsed))
    }

    /// Makes a GET request to the API in a blocking manner
    fn request_blocking<T: DeserializeOwned>(
        &self,
        path: &str,
        _query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let value = self.get(path)?;
        let parsed: T = serde_json::from_value(value).map_err(HyperlaneAleoError::from)?;
        Ok(parsed)
    }

    async fn request_post<T: DeserializeOwned>(&self, path: &str, _body: &Value) -> ChainResult<T> {
        // Treat POST similarly; retrieve registered response.
        let value = self.get(path)?;
        let parsed: T = serde_json::from_value(value).map_err(HyperlaneAleoError::from)?;
        Ok(parsed)
    }
}
