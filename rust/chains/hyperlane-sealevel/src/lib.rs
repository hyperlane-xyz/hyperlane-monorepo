//! Implementation of hyperlane for Sealevel.

#![forbid(unsafe_code)]
// FIXME
// #![warn(missing_docs)]
#![deny(warnings)]

pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use trait_builder::*;

// mod contracts; // FIXME
/// Copy pasted code from solana as a stop-gap solution until dependency conflicts are resolved.
pub mod solana;
use solana::nonblocking_rpc_client::RpcClient;
// use solana_client::non_blocking_rpc_client::RpcClient;

// mod conversions; // FIXME needed?
mod interchain_gas;
mod mailbox;
mod multisig_ism;
mod provider;
mod trait_builder;

// FIXME needed?
// /// Safe default imports of commonly used traits/types.
// pub mod prelude {
//     pub use crate::conversions::*;
// }

pub(crate) struct RpcClientWithDebug(RpcClient);

impl RpcClientWithDebug {
    pub fn new(rpc_endpoint: String) -> Self {
        Self(RpcClient::new(rpc_endpoint))
    }
}

impl std::fmt::Debug for RpcClientWithDebug {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RpcClient { ... }")
    }
}
