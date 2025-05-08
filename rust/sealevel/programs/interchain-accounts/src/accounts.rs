//! InterchainAccount accounts.
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
pub type InterchainAccountStorageAccount = AccountData<InterchainAccountStorage>;

/// The storage account's data.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct InterchainAccountStorage {
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
    /// Keyed by domain, the router for the remote domain.
    pub routers: HashMap<u32, H256>,
}

impl SizedData for InterchainAccountStorage {
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
        // routers
        (self.routers.len() * (std::mem::size_of::<u32>() + 32))
    }
}

impl AccessControl for InterchainAccountStorage {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

impl HyperlaneRouter for InterchainAccountStorage {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.routers.get(&origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.routers.insert(config.domain, config.router.unwrap());
    }
}

impl HyperlaneConnectionClient for InterchainAccountStorage {
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
