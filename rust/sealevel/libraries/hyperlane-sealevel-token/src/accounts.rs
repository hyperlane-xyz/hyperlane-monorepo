//! Accounts for the Hyperlane token program.

use access_control::AccessControl;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::{
    router::{
        HyperlaneRouter, HyperlaneRouterAccessControl, HyperlaneRouterDispatch,
        HyperlaneRouterMessageRecipient, RemoteRouterConfig,
    },
    HyperlaneConnectionClient, HyperlaneConnectionClientRecipient, HyperlaneConnectionClientSetter,
    HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::{collections::HashMap, fmt::Debug};

use crate::hyperlane_token_pda_seeds;

pub type HyperlaneTokenAccount<T> = AccountData<HyperlaneToken<T>>;

/// A PDA account containing the data for a Hyperlane token
/// and any plugin-specific data.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct HyperlaneToken<T> {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The Mailbox process authority specific to this program as the recipient.
    pub mailbox_process_authority: Pubkey,
    /// The dispatch authority PDA's bump seed.
    pub dispatch_authority_bump: u8,
    /// Access control owner.
    pub owner: Option<Pubkey>,
    /// The interchain security module.
    pub interchain_security_module: Option<Pubkey>,
    /// Remote routers.
    pub remote_routers: HashMap<u32, H256>,
    /// Plugin-specific data.
    pub plugin_data: T,
}

impl<T> HyperlaneToken<T>
where
    T: BorshSerialize + BorshDeserialize + Default + Debug,
{
    pub fn verify_account_and_fetch_inner<'a>(
        program_id: &Pubkey,
        token_account_info: &AccountInfo<'a>,
    ) -> Result<Self, ProgramError> {
        let token = HyperlaneTokenAccount::fetch(&mut &token_account_info.data.borrow_mut()[..])?
            .into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account_info.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(*token)
    }
}

impl<T> AccessControl for HyperlaneToken<T> {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

impl<T> HyperlaneConnectionClient for HyperlaneToken<T> {
    fn mailbox(&self) -> &Pubkey {
        &self.mailbox
    }

    // Not yet supported
    fn interchain_gas_paymaster(&self) -> Option<&Pubkey> {
        None
    }

    fn interchain_security_module(&self) -> Option<&Pubkey> {
        self.interchain_security_module.as_ref()
    }
}

impl<T> HyperlaneConnectionClientSetter for HyperlaneToken<T> {
    fn set_mailbox(&mut self, new_mailbox: Pubkey) {
        self.mailbox = new_mailbox;
    }

    fn set_interchain_gas_paymaster(&mut self, _new_igp: Option<Pubkey>) {
        // Not yet supported
    }

    fn set_interchain_security_module(&mut self, new_ism: Option<Pubkey>) {
        self.interchain_security_module = new_ism;
    }
}

impl<T> HyperlaneConnectionClientSetterAccessControl for HyperlaneToken<T> {}

impl<T> HyperlaneConnectionClientRecipient for HyperlaneToken<T> {
    fn mailbox_process_authority(&self) -> &Pubkey {
        &self.mailbox_process_authority
    }
}

impl<T> HyperlaneRouter for HyperlaneToken<T> {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.remote_routers.router(origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.remote_routers.enroll_remote_router(config);
    }
}

impl<T> HyperlaneRouterDispatch for HyperlaneToken<T> {}

impl<T> HyperlaneRouterAccessControl for HyperlaneToken<T> {}

impl<T> HyperlaneRouterMessageRecipient for HyperlaneToken<T> {}
