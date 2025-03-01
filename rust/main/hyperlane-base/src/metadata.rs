use derive_new::new;
use serde::{Deserialize, Serialize};

/// Metadata about agent
#[derive(Clone, Debug, Deserialize, Serialize, new)]
pub struct AgentMetadata {
    /// Contains git commit hash of the agent binary
    pub git_sha: String,
}
