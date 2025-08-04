pub use self::{
    interchain_gas::*, interchain_security_module::*, mailbox::*, merkle_tree_hook::*,
    multisig_ism::*, provider::*, signers::*, trait_builder::*, validator_announce::*,
};

macro_rules! custom_err {
    ($fmt:literal $(,)?) => {
        ::hyperlane_core::ChainCommunicationError::CustomError(format!($fmt))
    };
    ($fmt:literal, $($args:expr),+ $(,)?) => {
        ::hyperlane_core::ChainCommunicationError::CustomError(format!($fmt, $($args),+))
    };
}

pub mod application;
mod indexer;
mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod merkle_tree_hook;
mod multisig_ism;
mod provider;
mod signers;
mod trait_builder;
pub mod types;
mod validator_announce;
