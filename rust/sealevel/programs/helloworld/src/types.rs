//! Type definitions for the HelloWorld program.

use borsh::{BorshDeserialize, BorshSerialize};
use shank::ShankType;

/// Proxy struct for RemoteRouterConfig from hyperlane_sealevel_connection_client.
/// This tells Shank to import the type definition from the external library's IDL
/// instead of duplicating the fields here.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize, ShankType)]
#[shank(
    import_from = "hyperlane_sealevel_connection_client",
    rename = "RemoteRouterConfig"
)]
pub struct RemoteRouterConfigProxy;

// Re-export the real type for use in the program logic
pub use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
