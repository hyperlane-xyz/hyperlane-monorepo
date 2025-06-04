//! A plugin for the Hyperlane token program that transfers native
//! tokens in from a sender when sending to a remote chain, and transfers
//! native tokens out to recipients when receiving from a remote chain.

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
    system_instruction,
    sysvar::Sysvar,
};

/// Seeds relating to the PDA account that holds native collateral.
#[macro_export]
macro_rules! hyperlane_token_native_collateral_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"native_collateral"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            b"native_collateral",
            &[$bump_seed],
        ]
    }};
}

/// A plugin for the Hyperlane token program that transfers native
/// tokens in from a sender when sending to a remote chain, and transfers
/// native tokens out to recipients when receiving from a remote chain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct NativePlugin {
    /// The bump seed for the native collateral PDA account.
    pub native_collateral_bump: u8,
}

impl SizedData for NativePlugin {
    fn size(&self) -> usize {
        // native_collateral_bump
        std::mem::size_of::<u8>()
    }
}

impl NativePlugin {
    /// Returns Ok(()) if the native collateral account info is valid.
    /// Errors if the key or owner is incorrect.
    fn verify_native_collateral_account_info(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        native_collateral_account_info: &AccountInfo,
    ) -> Result<(), ProgramError> {
        let native_collateral_seeds: &[&[u8]] =
            hyperlane_token_native_collateral_pda_seeds!(token.plugin_data.native_collateral_bump);
        let expected_native_collateral_key =
            Pubkey::create_program_address(native_collateral_seeds, program_id)?;

        if native_collateral_account_info.key != &expected_native_collateral_key {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }
}

impl HyperlaneSealevelTokenPlugin for NativePlugin {
    /// Initializes the plugin.
    ///
    /// Accounts:
    /// 0. `[writable]` The native collateral PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        _token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account 0: Native collateral PDA account.
        let native_collateral_account = next_account_info(accounts_iter)?;
        let (native_collateral_key, native_collateral_bump) = Pubkey::find_program_address(
            hyperlane_token_native_collateral_pda_seeds!(),
            program_id,
        );
        if &native_collateral_key != native_collateral_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        // Create native collateral PDA account.
        // Assign ownership to the system program so it can transfer tokens.
        create_pda_account(
            payer_account,
            &Rent::get()?,
            0,
            &solana_program::system_program::id(),
            system_program,
            native_collateral_account,
            hyperlane_token_native_collateral_pda_seeds!(native_collateral_bump),
        )?;

        Ok(Self {
            native_collateral_bump,
        })
    }

    /// Transfers tokens into the program so they can be sent to a remote chain.
    /// Burns the tokens from the sender's associated token account.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The native token collateral PDA account.
    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Account 0: System program.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Native collateral PDA account.
        let native_collateral_account = next_account_info(accounts_iter)?;
        Self::verify_native_collateral_account_info(program_id, token, native_collateral_account)?;

        // Transfer tokens into the native collateral account.
        invoke(
            &system_instruction::transfer(sender_wallet.key, native_collateral_account.key, amount),
            &[sender_wallet.clone(), native_collateral_account.clone()],
        )
    }

    /// Transfers tokens out to a recipient's associated token account as a
    /// result of a transfer to this chain from a remote chain.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The native token collateral PDA account.
    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        _system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Account 0: System program.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Native collateral PDA account.
        let native_collateral_account = next_account_info(accounts_iter)?;
        Self::verify_native_collateral_account_info(program_id, token, native_collateral_account)?;

        invoke_signed(
            &system_instruction::transfer(
                native_collateral_account.key,
                recipient_wallet.key,
                amount,
            ),
            &[native_collateral_account.clone(), recipient_wallet.clone()],
            &[hyperlane_token_native_collateral_pda_seeds!(
                token.plugin_data.native_collateral_bump
            )],
        )?;

        // Ensure the native collateral account is still rent exempt.
        verify_rent_exempt(native_collateral_account, &Rent::get()?)?;

        Ok(())
    }

    /// Returns the accounts required for `transfer_out`.
    fn transfer_out_account_metas(
        program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        let (native_collateral_key, _native_collateral_bump) = Pubkey::find_program_address(
            hyperlane_token_native_collateral_pda_seeds!(),
            program_id,
        );

        Ok((
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false).into(),
                AccountMeta::new(native_collateral_key, false).into(),
            ],
            // Recipient wallet must be writeable to send lamports to it.
            true,
        ))
    }
}
