use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, message::TokenMessage, processor::HyperlaneSealevelTokenPlugin,
};
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    instruction::AccountMeta,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};

// TODO make these easily configurable?
pub const REMOTE_DECIMALS: u8 = 18;
pub const DECIMALS: u8 = 8;

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
    native_collateral_bump: u8,
}

impl HyperlaneSealevelTokenPlugin for NativePlugin {
    /// Initializes the plugin.
    ///
    /// Accounts:
    /// 0. [writable] The native collateral PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        _system_program: &'a AccountInfo<'b>,
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
        invoke_signed(
            &system_instruction::create_account(
                payer_account.key,
                native_collateral_account.key,
                Rent::default().minimum_balance(0),
                0,
                &solana_program::system_program::id(),
            ),
            &[payer_account.clone(), native_collateral_account.clone()],
            &[hyperlane_token_native_collateral_pda_seeds!(
                native_collateral_bump
            )],
        )?;

        Ok(Self {
            native_collateral_bump,
        })
    }

    /// Transfers tokens into the program so they can be sent to a remote chain.
    /// Burns the tokens from the sender's associated token account.
    ///
    /// Accounts:
    /// 0. [executable] The system program.
    /// 1. [writeable] The native token collateral PDA account.
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

        let native_collateral_seeds: &[&[u8]] =
            hyperlane_token_native_collateral_pda_seeds!(token.plugin_data.native_collateral_bump);
        let expected_native_collateral_key =
            Pubkey::create_program_address(native_collateral_seeds, program_id)?;
        if native_collateral_account.key != &expected_native_collateral_key {
            return Err(ProgramError::InvalidArgument);
        }
        // TODO should this be enforced????
        // if native_collateral_account.owner != program_id {
        //     return Err(ProgramError::IncorrectProgramId);
        // }

        // Hold native tokens that are now "off chain" in custody account.
        // TODO: does it need to be signed by this program? shouldn't...

        invoke(
            &system_instruction::transfer(sender_wallet.key, native_collateral_account.key, amount),
            &[sender_wallet.clone(), native_collateral_account.clone()],
        )
    }

    /// Transfers tokens out to a recipient's associated token account as a
    /// result of a transfer to this chain from a remote chain.
    ///
    /// Accounts:
    /// 0. [executable] The system program.
    /// 1. [writeable] The native token collateral PDA account.
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

        let native_collateral_seeds: &[&[u8]] =
            hyperlane_token_native_collateral_pda_seeds!(token.plugin_data.native_collateral_bump);
        let expected_native_collateral_key =
            Pubkey::create_program_address(native_collateral_seeds, program_id)?;
        if native_collateral_account.key != &expected_native_collateral_key {
            return Err(ProgramError::InvalidArgument);
        }
        // TODO should this be enforced????
        // if native_collateral_account.owner != program_id {
        //     return Err(ProgramError::IncorrectProgramId);
        // }

        invoke_signed(
            &system_instruction::transfer(
                native_collateral_account.key,
                recipient_wallet.key,
                amount,
            ),
            &[native_collateral_account.clone(), recipient_wallet.clone()],
            &[native_collateral_seeds],
        )
    }

    fn transfer_out_account_metas(
        program_id: &Pubkey,
        token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        let (native_collateral_key, _native_collateral_bump) = Pubkey::find_program_address(
            hyperlane_token_native_collateral_pda_seeds!(),
            program_id,
        );

        Ok((
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(native_collateral_key, false),
            ],
            // Recipient wallet must be writeable to send lamports to it.
            true,
        ))
    }
}
