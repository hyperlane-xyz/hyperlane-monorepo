use std::str::FromStr;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, NativeToken,
};
use url::Url;

/// Cosmos connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Aleo RPC
    pub rpc: Url,
    /// Plaintext program name of the mailbox
    pub mailbox_program: String,
    /// Hook manager program name
    pub hook_manager_program: String,
    /// Ism Manager program name
    pub ism_manager_program: String,
    /// Validator announce program name
    pub validator_announce_program: String,
    // TODO: network specific attributes
}

impl ConnectionConf {
    /// New Aleo Connection Config
    pub fn new(
        rpc_urls: Vec<Url>,
        mailbox_program: String,
        hook_manager_program: String,
        ism_manager_program: String,
        validator_announce_program: String,
    ) -> Self {
        Self {
            rpc: rpc_urls[0].clone(),
            mailbox_program,
            hook_manager_program,
            ism_manager_program,
            validator_announce_program,
        }
    }
}
