//! Implementation of hyperlane for Sealevel.

#![forbid(unsafe_code)]
// FIXME
// #![warn(missing_docs)]
#![deny(warnings)]

pub use interchain_gas::*;
pub use interchain_security_module::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use trait_builder::*;
pub use validator_announce::*;

/// Copy pasted code from solana as a stop-gap solution until dependency conflicts are resolved.
pub mod solana;
use solana::nonblocking_rpc_client::RpcClient;

mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod mailbox_message_inspector;
mod mailbox_token_bridge_message_inspector;
mod multisig_ism;
mod provider;
mod trait_builder;
mod validator_announce;

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
