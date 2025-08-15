use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Configuration for Kaspa deposit processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KaspaDepositConfig {
    /// Number of blue score confirmations required for finality
    #[serde(default = "default_finality_confirmations")]
    pub finality_confirmations: u32,

    /// Base retry delay in seconds (used for exponential backoff)
    #[serde(default = "default_base_retry_delay")]
    pub base_retry_delay_secs: u64,

    /// Maximum number of retries before giving up
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,

    /// Polling interval for checking new deposits
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,

    /// Seconds per confirmation (for calculating retry delays)
    #[serde(default = "default_secs_per_confirmation")]
    pub secs_per_confirmation: f64,
}

impl Default for KaspaDepositConfig {
    fn default() -> Self {
        Self {
            finality_confirmations: default_finality_confirmations(),
            base_retry_delay_secs: default_base_retry_delay(),
            max_retries: default_max_retries(),
            poll_interval_secs: default_poll_interval(),
            secs_per_confirmation: default_secs_per_confirmation(),
        }
    }
}

impl KaspaDepositConfig {
    /// Load from environment variables
    pub fn from_env() -> Self {
        Self {
            finality_confirmations: std::env::var("KASPA_FINALITY_CONFIRMATIONS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_finality_confirmations),
            base_retry_delay_secs: std::env::var("KASPA_BASE_RETRY_DELAY_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_base_retry_delay),
            max_retries: std::env::var("KASPA_MAX_RETRIES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_max_retries),
            poll_interval_secs: std::env::var("KASPA_POLL_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_poll_interval),
            secs_per_confirmation: std::env::var("KASPA_SECS_PER_CONFIRMATION")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_secs_per_confirmation),
        }
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_secs(self.poll_interval_secs)
    }

    pub fn base_retry_delay(&self) -> Duration {
        Duration::from_secs(self.base_retry_delay_secs)
    }
}

fn default_finality_confirmations() -> u32 {
    1000
}

fn default_base_retry_delay() -> u64 {
    30
}

fn default_max_retries() -> u32 {
    66 // Same as upstream default
}

fn default_poll_interval() -> u64 {
    10
}

fn default_secs_per_confirmation() -> f64 {
    1.0
}
