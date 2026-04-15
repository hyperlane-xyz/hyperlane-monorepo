//! Collateral (escrow) plugin for the factory program.
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
    program::{get_return_data, invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::{self, Sysvar},
};
use solana_system_interface::{self, program as system_program};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{get_account_data_size, initialize_account, transfer_checked};

/// Seeds for the factory route escrow PDA (salt-keyed).
#[macro_export]
macro_rules! hyperlane_token_route_escrow_pda_seeds {
    ($salt:expr) => {{
        &[b"hyperlane_token_escrow", $salt.as_ref()]
    }};

    ($salt:expr, $bump_seed:expr) => {{
        &[b"hyperlane_token_escrow", $salt.as_ref(), &[$bump_seed]]
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

/// Plugin for the collateral token factory.
/// Each route gets its own salt-keyed escrow and ATA payer PDA.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CollateralFactoryPlugin {
    /// The SPL token program (either spl-token or spl-token-2022).
    pub spl_token_program: Pubkey,
    /// The mint.
    pub mint: Pubkey,
    /// The escrow PDA account.
    pub escrow: Pubkey,
    /// The escrow PDA bump seed.
    pub escrow_bump: u8,
    /// The ATA payer PDA bump seed.
    pub ata_payer_bump: u8,
}

impl SizedData for CollateralFactoryPlugin {
    fn size(&self) -> usize {
        // spl_token_program
        32
            // mint
            + 32
            // escrow
            + 32
            // escrow_bump
            + std::mem::size_of::<u8>()
            // ata_payer_bump
            + std::mem::size_of::<u8>()
    }
}

impl HyperlaneSealevelTokenPlugin for CollateralFactoryPlugin {
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
    /// 0. `[executable]` SPL token program for the mint.
    /// 1. `[]`           The mint.
    /// 2. `[executable]` Rent sysvar.
    /// 3. `[writable]`   Escrow PDA: `["hyperlane_token_escrow", salt]`.
    /// 4. `[writable]`   ATA payer PDA: `["hyperlane_token_ata_payer", salt]`.
    fn initialize_for_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        system_program: &'a AccountInfo<'b>,
        _token_account_info: &'a AccountInfo<'b>,
        payer_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account 0: SPL token program.
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &spl_token_2022::id()
            && spl_token_account_info.key != &spl_token::id()
        {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.owner != spl_token_account_info.key {
            return Err(ProgramError::IllegalOwner);
        }

        // Account 2: Rent sysvar.
        let rent_account_info = next_account_info(accounts_iter)?;
        if rent_account_info.key != &sysvar::rent::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Escrow PDA (salt-keyed).
        let escrow_account_info = next_account_info(accounts_iter)?;
        let (escrow_key, escrow_bump) =
            Pubkey::find_program_address(hyperlane_token_route_escrow_pda_seeds!(salt), program_id);
        if &escrow_key != escrow_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }

        invoke(
            &get_account_data_size(spl_token_account_info.key, mint_account_info.key, &[])?,
            &[mint_account_info.clone()],
        )?;
        let account_data_size: u64 = get_return_data()
            .ok_or(ProgramError::InvalidArgument)
            .and_then(|(returning_pubkey, data)| {
                if &returning_pubkey != spl_token_account_info.key {
                    return Err(ProgramError::InvalidArgument);
                }
                let data: [u8; 8] = data
                    .as_slice()
                    .try_into()
                    .map_err(|_| ProgramError::InvalidArgument)?;
                Ok(u64::from_le_bytes(data))
            })?;

        let rent = Rent::get()?;

        create_pda_account(
            payer_account_info,
            &rent,
            account_data_size.try_into().unwrap(),
            spl_token_account_info.key,
            system_program,
            escrow_account_info,
            hyperlane_token_route_escrow_pda_seeds!(salt, escrow_bump),
        )?;

        invoke(
            &initialize_account(
                spl_token_account_info.key,
                escrow_account_info.key,
                mint_account_info.key,
                escrow_account_info.key,
            )?,
            &[
                escrow_account_info.clone(),
                mint_account_info.clone(),
                escrow_account_info.clone(),
                rent_account_info.clone(),
            ],
        )?;

        // Account 4: ATA payer PDA (salt-keyed).
        let ata_payer_account_info = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) = Pubkey::find_program_address(
            hyperlane_token_route_ata_payer_pda_seeds!(salt),
            program_id,
        );
        if &ata_payer_key != ata_payer_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }

        create_pda_account(
            payer_account_info,
            &rent,
            0,
            &system_program::ID,
            system_program,
            ata_payer_account_info,
            hyperlane_token_route_ata_payer_pda_seeds!(salt, ata_payer_bump),
        )?;

        Ok(Self {
            spl_token_program: *spl_token_account_info.key,
            mint: *mint_account_info.key,
            escrow: escrow_key,
            escrow_bump,
            ata_payer_bump,
        })
    }

    /// Transfers tokens from sender to escrow.
    ///
    /// Accounts:
    /// 0. `[executable]` SPL token program.
    /// 1. `[writable]`   Mint.
    /// 2. `[writable]`   Sender ATA.
    /// 3. `[writable]`   Escrow PDA.
    fn transfer_in_from_route<'a, 'b>(
        program_id: &Pubkey,
        _salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        sender_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Escrow key is stored in plugin_data — no need to re-derive from salt.
        Self::transfer_in(
            program_id,
            token,
            sender_wallet_account_info,
            accounts_iter,
            amount,
        )
    }

    /// Transfers tokens from escrow to recipient.
    ///
    /// Accounts:
    /// 0. `[executable]` SPL token program.
    /// 1. `[executable]` SPL associated token account program.
    /// 2. `[writable]`   Mint.
    /// 3. `[writable]`   Recipient ATA.
    /// 4. `[writable]`   ATA payer PDA: `["hyperlane_token_ata_payer", salt]`.
    /// 5. `[writable]`   Escrow PDA.
    fn transfer_out_from_route<'a, 'b>(
        program_id: &Pubkey,
        salt: &[u8; 32],
        token: &HyperlaneToken<Self>,
        system_program_account_info: &'a AccountInfo<'b>,
        recipient_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &token.plugin_data.spl_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_token_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        let spl_ata_account_info = next_account_info(accounts_iter)?;
        if spl_ata_account_info.key != &spl_associated_token_account::id() {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_ata_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.key != &token.plugin_data.mint {
            return Err(ProgramError::IncorrectProgramId);
        }

        let recipient_ata_account_info = next_account_info(accounts_iter)?;
        let expected_recipient_ata = get_associated_token_address_with_program_id(
            recipient_wallet_account_info.key,
            mint_account_info.key,
            spl_token_account_info.key,
        );
        if recipient_ata_account_info.key != &expected_recipient_ata {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !recipient_ata_account_info.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }

        // ATA payer: verify against salt-keyed PDA.
        let ata_payer_account_info = next_account_info(accounts_iter)?;
        let expected_ata_payer = Pubkey::create_program_address(
            hyperlane_token_route_ata_payer_pda_seeds!(salt, token.plugin_data.ata_payer_bump),
            program_id,
        )?;
        if ata_payer_account_info.key != &expected_ata_payer {
            return Err(ProgramError::InvalidArgument);
        }

        let escrow_account_info = next_account_info(accounts_iter)?;
        if escrow_account_info.key != &token.plugin_data.escrow {
            return Err(ProgramError::IncorrectProgramId);
        }

        invoke_signed(
            &create_associated_token_account_idempotent(
                ata_payer_account_info.key,
                recipient_wallet_account_info.key,
                mint_account_info.key,
                spl_token_account_info.key,
            ),
            &[
                ata_payer_account_info.clone(),
                recipient_ata_account_info.clone(),
                recipient_wallet_account_info.clone(),
                mint_account_info.clone(),
                system_program_account_info.clone(),
                spl_token_account_info.clone(),
            ],
            &[hyperlane_token_route_ata_payer_pda_seeds!(
                salt,
                token.plugin_data.ata_payer_bump
            )],
        )?;

        verify_rent_exempt(ata_payer_account_info, &Rent::get()?)?;

        let transfer_instruction = transfer_checked(
            spl_token_account_info.key,
            escrow_account_info.key,
            mint_account_info.key,
            recipient_ata_account_info.key,
            escrow_account_info.key,
            &[],
            amount,
            token.decimals,
        )?;

        invoke_signed(
            &transfer_instruction,
            &[
                escrow_account_info.clone(),
                mint_account_info.clone(),
                recipient_ata_account_info.clone(),
                escrow_account_info.clone(),
            ],
            &[hyperlane_token_route_escrow_pda_seeds!(
                salt,
                token.plugin_data.escrow_bump
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
            &token.plugin_data.spl_token_program,
        );

        Ok((
            vec![
                AccountMeta::new_readonly(token.plugin_data.spl_token_program, false).into(),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false).into(),
                AccountMeta::new_readonly(token.plugin_data.mint, false).into(),
                AccountMeta::new(recipient_ata, false).into(),
                AccountMeta::new(ata_payer_key, false).into(),
                AccountMeta::new(token.plugin_data.escrow, false).into(),
            ],
            false,
        ))
    }
}
