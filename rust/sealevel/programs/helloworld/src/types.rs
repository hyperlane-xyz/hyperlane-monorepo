//! Type definitions for the HelloWorld program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use shank::ShankType;

/// Configuration for a remote router.
/// This is a wrapper around hyperlane_sealevel_connection_client::router::RemoteRouterConfig
/// to include in the IDL.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize, ShankType)]
pub struct RemoteRouterConfig {
    /// The domain of the remote router.
    pub domain: u32,
    /// The remote router.
    #[idl_type("Option<[u8; 32]>")]
    pub router: Option<H256>,
}

impl From<hyperlane_sealevel_connection_client::router::RemoteRouterConfig>
    for RemoteRouterConfig
{
    fn from(
        config: hyperlane_sealevel_connection_client::router::RemoteRouterConfig,
    ) -> Self {
        Self {
            domain: config.domain,
            router: config.router,
        }
    }
}

impl From<RemoteRouterConfig>
    for hyperlane_sealevel_connection_client::router::RemoteRouterConfig
{
    fn from(config: RemoteRouterConfig) -> Self {
        Self {
            domain: config.domain,
            router: config.router,
        }
    }
}
