use std::{
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{offset::LocalResult, TimeZone, Utc};
use moka::Expiry;
use serde::{Deserialize, Serialize};

/// Default expiration time for cache entries.
static DEFAULT_EXPIRATION: OnceLock<Duration> = OnceLock::new();

pub fn default_expiration() -> Duration {
    *DEFAULT_EXPIRATION.get_or_init(|| {
        let secs = std::env::var("HYP_CACHEDEFAULTEXPIRATIONSECONDS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(120); // default: 2 minutes
        Duration::from_secs(secs)
    })
}

/// The type of expiration for a cache entry.
///
/// ## Variants
///
/// - `Never`: Never expire.
/// - `AfterDuration`: Expire after a specified duration.
/// - `AfterTimestamp`: Expire after a specified timestamp.
/// - `Default`: Use the default expiration. (2 minutes)
#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExpirationType {
    Never,
    AfterDuration(Duration),
    AfterTimestamp(u64),
    Default,
}

impl From<ExpirationType> for Expiration {
    fn from(expiration: ExpirationType) -> Self {
        Expiration {
            variant: expiration,
            created_at: Utc::now().timestamp() as u64,
        }
    }
}

/// Expiration to store alongside a cache entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Expiration {
    /// The type of expiration used when the entry was created.
    pub variant: ExpirationType,
    /// Unix timestamp when the entry was created.
    pub created_at: u64,
}

impl Expiration {
    /// Get the duration until the entry expires
    pub fn as_duration(&self) -> Option<Duration> {
        match self.variant {
            ExpirationType::AfterDuration(duration) => Some(duration),
            ExpirationType::AfterTimestamp(timestamp) => {
                let target_time = UNIX_EPOCH + Duration::from_secs(timestamp);
                target_time
                    .duration_since(SystemTime::now())
                    .ok()
                    .or(Some(Duration::ZERO))
            }
            ExpirationType::Never => None,
            ExpirationType::Default => Some(default_expiration()),
        }
    }

    /// Calculate the time to live for the entry
    /// Returns None if the entry should never expire or if the expiration time is in the past
    pub fn time_to_live(&self) -> Option<Duration> {
        let expiration = self.as_duration()?;
        let created_at = match Utc.timestamp_opt(self.created_at as i64, 0) {
            LocalResult::Single(time) => time,
            LocalResult::Ambiguous(earliest, _) => earliest,
            LocalResult::None => return None,
        };
        let now = Utc::now();
        let elapsed = now.signed_duration_since(created_at).to_std().ok()?;
        expiration.checked_sub(elapsed)
    }
}

/// A dynamic expiry policy that uses the expiration stored alongside the value.
/// Used for setting up a new cache with an expiry policy.
pub struct DynamicExpiry {}

impl Expiry<String, (String, Expiration)> for DynamicExpiry {
    fn expire_after_create(
        &self,
        _key: &String,
        value: &(String, Expiration),
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        value.1.as_duration()
    }
}
