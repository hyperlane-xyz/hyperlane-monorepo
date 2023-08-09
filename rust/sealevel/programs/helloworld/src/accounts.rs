//! HelloWorld accounts.
use std::collections::HashMap;

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::{
    router::{HyperlaneRouter, RemoteRouterConfig},
    HyperlaneConnectionClient,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// The storage account.
pub type HelloWorldStorageAccount = AccountData<HelloWorldStorage>;

/// The storage account's data.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct HelloWorldStorage {
    /// The local domain.
    pub local_domain: u32,
    /// The mailbox.
    pub mailbox: Pubkey,
    /// The ISM.
    pub ism: Option<Pubkey>,
    /// The IGP.
    pub igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The owner.
    pub owner: Option<Pubkey>,
    /// A counter of how many messages have been sent from this contract.
    pub sent: u64,
    /// A counter of how many messages have been received by this contract.
    pub received: u64,
    /// Keyed by domain, a counter of how many messages that have been sent
    /// from this contract to the domain.
    pub sent_to: HashMap<u32, u64>,
    /// Keyed by domain, a counter of how many messages that have been received
    /// by this contract from the domain.
    pub received_from: HashMap<u32, u64>,
    /// Keyed by domain, the router for the remote domain.
    pub routers: HashMap<u32, H256>,
}

impl SizedData for HelloWorldStorage {
    fn size(&self) -> usize {
        // local domain
        std::mem::size_of::<u32>() +
        // mailbox
        32 +
        // ism
        1 + 32 +
        // igp
        1 + 32 + 1 + 32 +
        // owner
        1 + 32 +
        // sent
        std::mem::size_of::<u64>() +
        // received
        std::mem::size_of::<u64>() +
        // sent_to
        (self.sent_to.len() * (std::mem::size_of::<u32>() + std::mem::size_of::<u64>())) +
        // received_from
        (self.received_from.len() * (std::mem::size_of::<u32>() + std::mem::size_of::<u64>())) +
        // routers
        (self.routers.len() * (std::mem::size_of::<u32>() + 32))
    }
}

impl AccessControl for HelloWorldStorage {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

impl HyperlaneRouter for HelloWorldStorage {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.routers.get(&origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.routers.insert(config.domain, config.router.unwrap());
    }
}

impl HyperlaneConnectionClient for HelloWorldStorage {
    fn mailbox(&self) -> &Pubkey {
        &self.mailbox
    }

    fn interchain_gas_paymaster(&self) -> Option<&(Pubkey, InterchainGasPaymasterType)> {
        self.igp.as_ref()
    }

    fn interchain_security_module(&self) -> Option<&Pubkey> {
        self.ism.as_ref()
    }
}
