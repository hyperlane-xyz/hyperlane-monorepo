//! Synthetic (mint/burn) plugin for the factory program.
//!
//! Identical in behaviour to `SyntheticPlugin` but uses salt-keyed PDAs
//! so that a single deployed program can host many independent warp routes.

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
use solana_system_interface::program as system_program;
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{burn_checked, mint_to_checked};

/// Seeds for the factory route mint PDA (salt-keyed).
#[macro_export]
macro_rules! hyperlane_token_route_mint_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_token_mint", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[b"hyperlane_token_mint", $salt.as_ref(), &[$bump_seed]]
    }};
}

/// Seeds for the factory route ATA payer PDA (salt-keyed).
#[macro_export]
macro_rules! hyperlane_token_route_ata_payer_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_token_ata_payer", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[b"hyperlane_token_ata_payer", $salt.as_ref(), &[$bump_seed]]
    }};
}

/// Plugin for the synthetic token factory.
/// Each route within the factory gets its own salt-keyed mint and ATA payer PDA.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct SyntheticFactoryPlugin {
    /// The mint / mint authority PDA account.
    pub mint: Pubkey,
    /// The bump seed for the mint / mint authority PDA account.
    pub mint_bump: u8,
    /// The bump seed for the ATA payer PDA account.
    pub ata_payer_bump: u8,
}

impl SizedData for SyntheticFactoryPlugin {
    fn size(&self) -> usize {
        // mint
        32 +
        // mint_bump
        std::mem::size_of::<u8>() +
        // ata_payer_bump
        std::mem::size_of::<u8>()
    }
}

impl SyntheticFactoryPlugin {
    /// The size of the mint account (SPL token 2022 with MetadataPointer extension).
    const MINT_ACCOUNT_SIZE: usize = 234;
}

impl HyperlaneSealevelTokenPlugin for SyntheticFactoryPlugin {
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
    /// 0. `[writable]` The mint / mint authority PDA: `["hyperlane_token_mint", salt]`.
    /// 1. `[writable]` The ATA payer PDA: `["hyperlane_token_ata_payer", salt]`.
    fn initialize_for_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        system_program: &'a AccountInfo<'b>,
        _token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account 0: Mint / mint authority (salt-keyed).
        let mint_account = next_account_info(accounts_iter)?;
        let (mint_key, mint_bump) =
            Pubkey::find_program_address(hyperlane_token_route_mint_pda_seeds!(salt), program_id);
        if &mint_key != mint_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        let rent = Rent::get()?;

        create_pda_account(
            payer_account,
            &rent,
            Self::MINT_ACCOUNT_SIZE,
            &spl_token_2022::id(),
            system_program,
            mint_account,
            hyperlane_token_route_mint_pda_seeds!(salt, mint_bump),
        )?;

        // Account 1: ATA payer (salt-keyed).
        let ata_payer_account = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) = Pubkey::find_program_address(
            hyperlane_token_route_ata_payer_pda_seeds!(salt),
            program_id,
        );
        if &ata_payer_key != ata_payer_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        create_pda_account(
            payer_account,
            &rent,
            0,
            &system_program::ID,
            system_program,
            ata_payer_account,
            hyperlane_token_route_ata_payer_pda_seeds!(salt, ata_payer_bump),
        )?;

        Ok(Self {
            mint: mint_key,
            mint_bump,
            ata_payer_bump,
        })
    }

    /// Burns tokens from the sender's ATA.
    ///
    /// Accounts:
    /// 0. `[executable]` SPL token 2022 program.
    /// 1. `[writable]`   Mint PDA: `["hyperlane_token_mint", salt]`.
    /// 2. `[writable]`   Sender's ATA.
    fn transfer_in_from_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let spl_token_2022 = next_account_info(accounts_iter)?;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }

        let mint_account = next_account_info(accounts_iter)?;
        let expected_mint = Pubkey::create_program_address(
            hyperlane_token_route_mint_pda_seeds!(salt, token.plugin_data.mint_bump),
            program_id,
        )?;
        if mint_account.key != &expected_mint || *mint_account.key != token.plugin_data.mint {
            return Err(ProgramError::InvalidArgument);
        }

        let sender_ata = next_account_info(accounts_iter)?;
        let expected_sender_ata = get_associated_token_address_with_program_id(
            sender_wallet.key,
            mint_account.key,
            &spl_token_2022::id(),
        );
        if sender_ata.key != &expected_sender_ata {
            return Err(ProgramError::InvalidArgument);
        }

        let burn_ixn = burn_checked(
            &spl_token_2022::id(),
            sender_ata.key,
            mint_account.key,
            sender_wallet.key,
            &[sender_wallet.key],
            amount,
            token.decimals,
        )?;
        invoke(
            &burn_ixn,
            &[
                sender_ata.clone(),
                mint_account.clone(),
                sender_wallet.clone(),
            ],
        )?;

        Ok(())
    }

    /// Mints tokens to the recipient's ATA.
    ///
    /// Accounts:
    /// 0. `[executable]` SPL token 2022 program.
    /// 1. `[executable]` SPL associated token account program.
    /// 2. `[writable]`   Mint PDA: `["hyperlane_token_mint", salt]`.
    /// 3. `[writable]`   Recipient ATA.
    /// 4. `[writable]`   ATA payer PDA: `["hyperlane_token_ata_payer", salt]`.
    fn transfer_out_from_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let spl_token_2022 = next_account_info(accounts_iter)?;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }
        let spl_ata = next_account_info(accounts_iter)?;
        if spl_ata.key != &spl_associated_token_account::id() || !spl_ata.executable {
            return Err(ProgramError::InvalidArgument);
        }

        let mint_account = next_account_info(accounts_iter)?;
        let expected_mint = Pubkey::create_program_address(
            hyperlane_token_route_mint_pda_seeds!(salt, token.plugin_data.mint_bump),
            program_id,
        )?;
        if mint_account.key != &expected_mint || *mint_account.key != token.plugin_data.mint {
            return Err(ProgramError::InvalidArgument);
        }

        let recipient_ata = next_account_info(accounts_iter)?;
        let expected_recipient_ata = get_associated_token_address_with_program_id(
            recipient_wallet.key,
            mint_account.key,
            &spl_token_2022::id(),
        );
        if recipient_ata.key != &expected_recipient_ata {
            return Err(ProgramError::InvalidArgument);
        }

        let ata_payer_account = next_account_info(accounts_iter)?;
        let expected_ata_payer = Pubkey::create_program_address(
            hyperlane_token_route_ata_payer_pda_seeds!(salt, token.plugin_data.ata_payer_bump),
            program_id,
        )?;
        if ata_payer_account.key != &expected_ata_payer {
            return Err(ProgramError::InvalidArgument);
        }

        invoke_signed(
            &create_associated_token_account_idempotent(
                ata_payer_account.key,
                recipient_wallet.key,
                mint_account.key,
                &spl_token_2022::id(),
            ),
            &[
                ata_payer_account.clone(),
                recipient_ata.clone(),
                recipient_wallet.clone(),
                mint_account.clone(),
                system_program.clone(),
                spl_token_2022.clone(),
            ],
            &[hyperlane_token_route_ata_payer_pda_seeds!(
                salt,
                token.plugin_data.ata_payer_bump
            )],
        )?;

        verify_rent_exempt(recipient_ata, &Rent::get()?)?;

        let mint_ixn = mint_to_checked(
            &spl_token_2022::id(),
            mint_account.key,
            recipient_ata.key,
            mint_account.key,
            &[],
            amount,
            token.decimals,
        )?;
        invoke_signed(
            &mint_ixn,
            &[
                mint_account.clone(),
                recipient_ata.clone(),
                mint_account.clone(),
            ],
            &[hyperlane_token_route_mint_pda_seeds!(
                salt,
                token.plugin_data.mint_bump
            )],
        )?;

        Ok(())
    }

    fn transfer_out_account_metas_for_route(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        let ata_payer_key = Pubkey::create_program_address(
            hyperlane_token_route_ata_payer_pda_seeds!(salt, token.plugin_data.ata_payer_bump),
            program_id,
        )?;

        let recipient_ata = get_associated_token_address_with_program_id(
            &Pubkey::new_from_array(token_message.recipient().into()),
            &token.plugin_data.mint,
            &spl_token_2022::id(),
        );

        Ok((
            vec![
                AccountMeta::new_readonly(spl_token_2022::id(), false).into(),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false).into(),
                AccountMeta::new(token.plugin_data.mint, false).into(),
                AccountMeta::new(recipient_ata, false).into(),
                AccountMeta::new(ata_payer_key, false).into(),
            ],
            false,
        ))
    }
}
