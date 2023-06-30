//! Accounts for the Hyperlane token program.

use access_control::AccessControl;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_connection_client::{
    router::{HyperlaneRouter, RemoteRouterConfig},
    HyperlaneConnectionClient, HyperlaneConnectionClientRecipient, HyperlaneConnectionClientSetter,
    HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_mailbox::accounts::AccountData;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::{cmp::Ordering, collections::HashMap, fmt::Debug};

use crate::hyperlane_token_pda_seeds;

/// HyperlaneToken account data.
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
    /// The decimals of the local token.
    pub decimals: u8,
    /// The decimals of the remote token.
    pub remote_decimals: u8,
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
    /// Deserializes the data from the provided `token_account_info` and returns it.
    /// Returns an Err if the provided `token_account_info` is not the canonical HyperlaneToken PDA for this program.
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

    /// Converts a local token amount to a remote token amount, accounting for decimals and types.
    pub fn local_amount_to_remote_amount(&self, amount: u64) -> Result<U256, ProgramError> {
        convert_decimals(amount.into(), self.decimals, self.remote_decimals)
            .ok_or(ProgramError::InvalidArgument)
    }

    /// Converts a remote token amount to a local token amount, accounting for decimals and types.
    pub fn remote_amount_to_local_amount(&self, amount: U256) -> Result<u64, ProgramError> {
        let amount = convert_decimals(amount, self.remote_decimals, self.decimals)
            .ok_or(ProgramError::InvalidArgument)?
            .as_u64();
        Ok(amount)
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

/// Converts an amount from one decimal representation to another.
pub fn convert_decimals(amount: U256, from_decimals: u8, to_decimals: u8) -> Option<U256> {
    match from_decimals.cmp(&to_decimals) {
        Ordering::Greater => {
            let divisor = U256::from(10u64).checked_pow(U256::from(from_decimals - to_decimals));
            divisor.and_then(|d| amount.checked_div(d))
        }
        Ordering::Less => {
            let multiplier = U256::from(10u64).checked_pow(U256::from(to_decimals - from_decimals));
            multiplier.and_then(|m| amount.checked_mul(m))
        }
        Ordering::Equal => Some(amount),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_convert_decimals() {
        // No decimal difference
        assert_eq!(
            convert_decimals(U256::from(100), 2, 2),
            Some(U256::from(100))
        );

        // Low decimals -> High decimals
        assert_eq!(
            convert_decimals(U256::from(100), 2, 5),
            Some(U256::from(100000))
        );

        // High decimals -> Low decimals
        assert_eq!(
            convert_decimals(U256::from(100000), 5, 2),
            Some(U256::from(100))
        );

        // High decimals -> Low decimals, with loss of precision
        assert_eq!(
            convert_decimals(U256::from(100001), 5, 2),
            Some(U256::from(100))
        );
    }

    #[test]
    fn test_local_amount_to_remote_amount() {
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 18,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.local_amount_to_remote_amount(1_000_000_000),
            Ok(U256::from(10).pow(U256::from(18)))
        );

        // Try an overflow
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 200,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.local_amount_to_remote_amount(1_000_000_000),
            Err(ProgramError::InvalidArgument)
        );

        // Try a loss of precision
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 5,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(token.local_amount_to_remote_amount(100), Ok(U256::zero()));
    }

    #[test]
    fn test_remote_amount_to_local_amount() {
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 18,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.remote_amount_to_local_amount(U256::from(10u64).pow(U256::from(18u64))),
            Ok(10u64.pow(9u32))
        );

        // Try an overflow
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 200,
            remote_decimals: 9,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.remote_amount_to_local_amount(1_000_000_000u64.into()),
            Err(ProgramError::InvalidArgument)
        );

        // Try a loss of precision
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 5,
            remote_decimals: 9,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(token.remote_amount_to_local_amount(100u64.into()), Ok(0));
    }
}
