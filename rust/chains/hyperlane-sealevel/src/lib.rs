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
pub use solana;
use solana::nonblocking_rpc_client::RpcClient;
pub use trait_builder::*;
pub use validator_announce::*;

mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod multisig_ism;
mod provider;
mod trait_builder;
mod utils;

mod validator_announce;

/// Kludge to implement Debug for RpcClient.
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

impl std::ops::Deref for RpcClientWithDebug {
    type Target = RpcClient;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
