//! Native SOL collateral plugin for the factory program.
//!
//! Uses salt-keyed PDAs so that a single deployed program can host many
//! independent warp routes.

use account_utils::{create_pda_account, verify_rent_exempt, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, processor::HyperlaneSealevelTokenPlugin,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    instruction::AccountMeta,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

/// Seeds for the factory route native collateral PDA (salt-keyed).
#[macro_export]
macro_rules! hyperlane_token_route_native_collateral_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_token_native_coll", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_token_native_coll",
            $salt.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// Plugin for the native SOL factory.
/// Each route gets its own salt-keyed native collateral PDA.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct NativeFactoryPlugin {
    /// The bump seed for the native collateral PDA.
    pub native_collateral_bump: u8,
}

impl SizedData for NativeFactoryPlugin {
    fn size(&self) -> usize {
        std::mem::size_of::<u8>()
    }
}

impl HyperlaneSealevelTokenPlugin for NativeFactoryPlugin {
    /// Not used by the factory — call `initialize_for_route` instead.
    fn initialize<'a, 'b>(
        _program_id: &Pubkey,
        _system_program: &'a AccountInfo<'b>,
        _token_account: &'a AccountInfo<'b>,
        _payer_account: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        Err(ProgramError::InvalidInstructionData)
    }

    /// Not used by the factory — call `transfer_in_from_route` instead.
    fn transfer_in<'a, 'b>(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _sender_wallet: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        _amount: u64,
    ) -> Result<(), ProgramError> {
        Err(ProgramError::InvalidInstructionData)
    }

    /// Not used by the factory — call `transfer_out_from_route` instead.
    fn transfer_out<'a, 'b>(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _system_program: &'a AccountInfo<'b>,
        _recipient_wallet: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        _amount: u64,
    ) -> Result<(), ProgramError> {
        Err(ProgramError::InvalidInstructionData)
    }

    /// Not used by the factory — call `transfer_out_account_metas_for_route` instead.
    fn transfer_out_account_metas(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        Err(ProgramError::InvalidInstructionData)
    }

    // ── Factory implementations ───────────────────────────────────────────────

    /// Initializes plugin state for a new factory route.
    ///
    /// Accounts:
    /// 0. `[writable]` Native collateral PDA: `["hyperlane_token_native_collateral", salt]`.
    fn initialize_for_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        system_program: &'a AccountInfo<'b>,
        _token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        let native_collateral_account = next_account_info(accounts_iter)?;
        let (native_collateral_key, native_collateral_bump) = Pubkey::find_program_address(
            hyperlane_token_route_native_collateral_pda_seeds!(salt),
            program_id,
        );
        if &native_collateral_key != native_collateral_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        create_pda_account(
            payer_account,
            &Rent::get()?,
            0,
            &system_program::ID,
            system_program,
            native_collateral_account,
            hyperlane_token_route_native_collateral_pda_seeds!(salt, native_collateral_bump),
        )?;

        Ok(Self {
            native_collateral_bump,
        })
    }

    /// Transfers SOL from sender into the native collateral PDA.
    ///
    /// Accounts:
    /// 0. `[executable]` System program.
    /// 1. `[writable]`   Native collateral PDA: `["hyperlane_token_native_collateral", salt]`.
    fn transfer_in_from_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let system_program_account = next_account_info(accounts_iter)?;
        if system_program_account.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        let native_collateral_account = next_account_info(accounts_iter)?;
        let expected_collateral = Pubkey::create_program_address(
            hyperlane_token_route_native_collateral_pda_seeds!(
                salt,
                token.plugin_data.native_collateral_bump
            ),
            program_id,
        )?;
        if native_collateral_account.key != &expected_collateral {
            return Err(ProgramError::InvalidArgument);
        }

        invoke(
            &system_instruction::transfer(sender_wallet.key, native_collateral_account.key, amount),
            &[sender_wallet.clone(), native_collateral_account.clone()],
        )
    }

    /// Transfers SOL from the native collateral PDA to the recipient.
    ///
    /// Accounts:
    /// 0. `[executable]` System program.
    /// 1. `[writable]`   Native collateral PDA: `["hyperlane_token_native_collateral", salt]`.
    fn transfer_out_from_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        _system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let system_program_account = next_account_info(accounts_iter)?;
        if system_program_account.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        let native_collateral_account = next_account_info(accounts_iter)?;
        let expected_collateral = Pubkey::create_program_address(
            hyperlane_token_route_native_collateral_pda_seeds!(
                salt,
                token.plugin_data.native_collateral_bump
            ),
            program_id,
        )?;
        if native_collateral_account.key != &expected_collateral {
            return Err(ProgramError::InvalidArgument);
        }

        invoke_signed(
            &system_instruction::transfer(
                native_collateral_account.key,
                recipient_wallet.key,
                amount,
            ),
            &[native_collateral_account.clone(), recipient_wallet.clone()],
            &[hyperlane_token_route_native_collateral_pda_seeds!(
                salt,
                token.plugin_data.native_collateral_bump
            )],
        )?;

        verify_rent_exempt(native_collateral_account, &Rent::get()?)?;

        Ok(())
    }

    fn transfer_out_account_metas_for_route(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        let native_collateral_key = Pubkey::create_program_address(
            hyperlane_token_route_native_collateral_pda_seeds!(
                salt,
                token.plugin_data.native_collateral_bump
            ),
            program_id,
        )?;

        Ok((
            vec![
                AccountMeta::new_readonly(system_program::ID, false).into(),
                AccountMeta::new(native_collateral_key, false).into(),
            ],
            // Recipient wallet must be writable to receive lamports.
            true,
        ))
    }
}
