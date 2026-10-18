use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

/// Configuration for a remote router.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize)]
pub struct RemoteRouterConfig {
    /// The domain of the remote router.
    pub domain: u32,
    /// The remote router.
    pub router: Option<H256>,
}
