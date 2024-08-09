use derive_new::new;
use serde::{Deserialize, Serialize};

/// Metadata about agent
#[derive(Debug, Deserialize, Serialize, new)]
pub struct AgentMetadata {
    /// Latest git commit hash at the time when agent was built
    /// If .git was not present at the time of build, field defaults to "VERGEN_IDEMPOTENT_OUTPUT"
    pub git_sha: String,
}
