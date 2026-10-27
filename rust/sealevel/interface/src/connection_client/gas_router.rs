use borsh::{BorshDeserialize, BorshSerialize};

/// Gas router configuration for a single destination.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize)]
pub struct GasRouterConfig {
    /// The domain of the remote router.
    pub domain: u32,
    /// The remote router.
    pub gas: Option<u64>,
}
