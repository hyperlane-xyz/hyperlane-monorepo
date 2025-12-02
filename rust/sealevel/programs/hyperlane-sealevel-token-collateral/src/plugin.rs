//! A plugin for the Hyperlane token program that escrows SPL tokens as collateral.

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
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{get_account_data_size, initialize_account, transfer_checked};

/// Seeds relating to the PDA account that acts both as the mint
/// *and* the mint authority.
#[macro_export]
macro_rules! hyperlane_token_escrow_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"escrow"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"escrow", &[$bump_seed]]
    }};
}

/// Seeds relating to the PDA account that acts as the payer for
/// ATA creation.
#[macro_export]
macro_rules! hyperlane_token_ata_payer_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"ata_payer"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"ata_payer", &[$bump_seed]]
    }};
}

/// A plugin for the Hyperlane token program that escrows SPL
/// tokens when transferring out to a remote chain, and pays them
/// out when transferring in from a remote chain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CollateralPlugin {
    /// The SPL token program, i.e. either SPL token program or the 2022 version.
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

impl SizedData for CollateralPlugin {
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

impl CollateralPlugin {
    fn verify_ata_payer_account_info(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        ata_payer_account_info: &AccountInfo,
    ) -> Result<(), ProgramError> {
        let ata_payer_seeds: &[&[u8]] =
            hyperlane_token_ata_payer_pda_seeds!(token.plugin_data.ata_payer_bump);
        let expected_ata_payer_account =
            Pubkey::create_program_address(ata_payer_seeds, program_id)?;
        if ata_payer_account_info.key != &expected_ata_payer_account {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }
}

impl HyperlaneSealevelTokenPlugin for CollateralPlugin {
    /// Initializes the plugin.
    ///
    /// Accounts:
    /// 0. `[executable]` The SPL token program for the mint, i.e. either SPL token program or the 2022 version.
    /// 1. `[]` The mint.
    /// 2. `[executable]` The Rent sysvar program.
    /// 3. `[writable]` The escrow PDA account.
    /// 4. `[writable]` The ATA payer PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        _token_account_info: &'a AccountInfo<'b>,
        payer_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account 0: The SPL token program.
        // This can either be the original SPL token program or the 2022 version.
        // This is saved in the HyperlaneToken plugin data so that future interactions
        // are done with the correct SPL token program.
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

        // Account 2: The Rent sysvar program.
        let rent_account_info = next_account_info(accounts_iter)?;
        if rent_account_info.key != &sysvar::rent::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Escrow PDA account.
        let escrow_account_info = next_account_info(accounts_iter)?;
        let (escrow_key, escrow_bump) =
            Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), program_id);
        if &escrow_key != escrow_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Get the required account size for the escrow PDA.
        invoke(
            &get_account_data_size(
                spl_token_account_info.key,
                mint_account_info.key,
                // No additional extensions
                &[],
            )?,
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

        // Create escrow PDA owned by the SPL token program.
        create_pda_account(
            payer_account_info,
            &rent,
            account_data_size.try_into().unwrap(),
            spl_token_account_info.key,
            system_program,
            escrow_account_info,
            hyperlane_token_escrow_pda_seeds!(escrow_bump),
        )?;

        // And initialize the escrow account.
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

        // Account 4: ATA payer.
        let ata_payer_account_info = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) =
            Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);
        if &ata_payer_key != ata_payer_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Create the ATA payer.
        // This is a separate PDA because the ATA program requires
        // the payer to have no data in it.
        create_pda_account(
            payer_account_info,
            &rent,
            0,
            // Grant ownership to the system program so that the ATA program
            // can call into the system program with the ATA payer as the
            // payer.
            &solana_program::system_program::id(),
            system_program,
            ata_payer_account_info,
            hyperlane_token_ata_payer_pda_seeds!(ata_payer_bump),
        )?;

        Ok(Self {
            spl_token_program: *spl_token_account_info.key,
            mint: *mint_account_info.key,
            escrow: escrow_key,
            escrow_bump,
            ata_payer_bump,
        })
    }

    /// Transfers tokens to the escrow account so they can be sent to a remote chain.
    /// Burns the tokens from the sender's associated token account.
    ///
    /// Accounts:
    /// 0. `[executable]` The SPL token program for the mint.
    /// 1. `[writeable]` The mint.
    /// 2. `[writeable]` The token sender's associated token account, from which tokens will be sent.
    /// 3. `[writeable]` The escrow PDA account.
    fn transfer_in<'a, 'b>(
        _program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Account 0: SPL token program.
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &token.plugin_data.spl_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_token_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 1: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.key != &token.plugin_data.mint {
            return Err(ProgramError::IncorrectProgramId);
        }
        if mint_account_info.owner != spl_token_account_info.key {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 2: The sender's associated token account.
        let sender_ata_account_info = next_account_info(accounts_iter)?;
        let expected_sender_associated_token_key = get_associated_token_address_with_program_id(
            sender_wallet_account_info.key,
            mint_account_info.key,
            spl_token_account_info.key,
        );
        if sender_ata_account_info.key != &expected_sender_associated_token_key {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: The escrow PDA account.
        let escrow_account_info = next_account_info(accounts_iter)?;
        if escrow_account_info.key != &token.plugin_data.escrow {
            return Err(ProgramError::IncorrectProgramId);
        }

        let transfer_instruction = transfer_checked(
            spl_token_account_info.key,
            sender_ata_account_info.key,
            mint_account_info.key,
            escrow_account_info.key,
            sender_wallet_account_info.key,
            // Multisignatures not supported at the moment.
            &[],
            amount,
            token.decimals,
        )?;

        // Sender wallet is expected to have signed this transaction.
        invoke(
            &transfer_instruction,
            &[
                sender_ata_account_info.clone(),
                mint_account_info.clone(),
                escrow_account_info.clone(),
                sender_wallet_account_info.clone(),
            ],
        )?;

        Ok(())
    }

    /// Transfers tokens out to a recipient's associated token account as a
    /// result of a transfer to this chain from a remote chain.
    ///
    /// Accounts:
    /// 0. `[executable]` SPL token for the mint.
    /// 1. `[executable]` SPL associated token account.
    /// 2. `[writeable]` Mint account.
    /// 3. `[writeable]` Recipient associated token account.
    /// 4. `[writeable]` ATA payer PDA account.
    /// 5. `[writeable]` Escrow account.
    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program_account_info: &'a AccountInfo<'b>,
        recipient_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Account 0: SPL token program.
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &token.plugin_data.spl_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_token_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 1: SPL associated token account
        let spl_ata_account_info = next_account_info(accounts_iter)?;
        if spl_ata_account_info.key != &spl_associated_token_account::id() {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_ata_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 2: Mint account
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.key != &token.plugin_data.mint {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Recipient associated token account
        let recipient_ata_account_info = next_account_info(accounts_iter)?;
        let expected_recipient_associated_token_account_key =
            get_associated_token_address_with_program_id(
                recipient_wallet_account_info.key,
                mint_account_info.key,
                spl_token_account_info.key,
            );
        if recipient_ata_account_info.key != &expected_recipient_associated_token_account_key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !recipient_ata_account_info.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 4: ATA payer PDA account
        let ata_payer_account_info = next_account_info(accounts_iter)?;
        Self::verify_ata_payer_account_info(program_id, token, ata_payer_account_info)?;

        // Account 5: Escrow account.
        let escrow_account_info = next_account_info(accounts_iter)?;
        if escrow_account_info.key != &token.plugin_data.escrow {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Create and init (this does both) associated token account if necessary.
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
            &[hyperlane_token_ata_payer_pda_seeds!(
                token.plugin_data.ata_payer_bump
            )],
        )?;

        // After potentially paying for the ATA creation, we need to make sure
        // the ATA payer still meets the rent-exemption requirements!
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
            &[hyperlane_token_escrow_pda_seeds!(
                token.plugin_data.escrow_bump
            )],
        )?;

        Ok(())
    }

    /// Returns the accounts required for `transfer_out`.
    fn transfer_out_account_metas(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        let ata_payer_account_key = Pubkey::create_program_address(
            hyperlane_token_ata_payer_pda_seeds!(token.plugin_data.ata_payer_bump),
            program_id,
        )?;

        let recipient_associated_token_account = get_associated_token_address_with_program_id(
            &Pubkey::new_from_array(token_message.recipient().into()),
            &token.plugin_data.mint,
            &token.plugin_data.spl_token_program,
        );

        Ok((
            vec![
                AccountMeta::new_readonly(token.plugin_data.spl_token_program, false).into(),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false).into(),
                AccountMeta::new_readonly(token.plugin_data.mint, false).into(),
                AccountMeta::new(recipient_associated_token_account, false).into(),
                AccountMeta::new(ata_payer_account_key, false).into(),
                AccountMeta::new(token.plugin_data.escrow, false).into(),
            ],
            // The recipient does not need to be writeable
            false,
        ))
    }
}
