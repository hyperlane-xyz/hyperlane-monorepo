use derive_new::new;
use serde::{Deserialize, Serialize};

use crate::MetadataFromSettings;

/// Metadata about agent
#[derive(Debug, Deserialize, Serialize, new)]
pub struct AgentMetadata {
    /// Contains git commit hash of the agent binary
    pub git_sha: String,
}

/// Default is always the latest git commit hash at the time of build
impl<T> MetadataFromSettings<T> for AgentMetadata {
    fn build_metadata(_settings: &T) -> Self {
        Self { git_sha: git_sha() }
    }
}

/// Returns latest git commit hash at the time when agent was built.
///
/// If .git was not present at the time of build,
/// the variable defaults to "VERGEN_IDEMPOTENT_OUTPUT".
pub fn git_sha() -> String {
    env!("VERGEN_GIT_SHA").to_string()
}
