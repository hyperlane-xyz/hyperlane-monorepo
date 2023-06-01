use crate::error::Error;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, message::TokenMessage, processor::HyperlaneSealevelTokenPlugin,
};
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    // instruction::AccountMeta,
    program::{get_return_data, invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack as _,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{get_account_data_size, initialize_account, transfer_checked};

// TODO make these easily configurable?
pub const REMOTE_DECIMALS: u8 = 18;
pub const DECIMALS: u8 = 8;

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
    pub mint: Pubkey,
    pub escrow: Pubkey,
    pub escrow_bump: u8,
    pub ata_payer_bump: u8,
}

impl CollateralPlugin {
    // TODO: what about spl_token
    pub const MINT_ACCOUNT_SIZE: usize = spl_token_2022::state::Mint::LEN;
}

impl HyperlaneSealevelTokenPlugin for CollateralPlugin {
    /// Initializes the plugin.
    ///
    /// Accounts:
    /// 0. [] The mint.
    /// 1. [executable] The SPL token 2022 program.
    /// 2. [executable] The Rent sysvar program.
    /// 3. [writable] The escrow PDA account.
    /// 4. [writable] The ATA payer PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        _system_program: &'a AccountInfo<'b>,
        _token_account_info: &'a AccountInfo<'b>,
        payer_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        println!("CollateralPlugin initialize?");

        // Account 0: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;

        // Account 1: The SPL token 2022 program.
        let spl_token_2022_account_info = next_account_info(accounts_iter)?;
        if spl_token_2022_account_info.key != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
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

        let spl_token_2022_id = spl_token_2022::id();

        // Get the required account size for the escrow PDA.
        invoke(
            &get_account_data_size(
                &spl_token_2022_id,
                mint_account_info.key,
                // No additional extensions
                &[],
            )?,
            &[mint_account_info.clone()],
        )?;
        let account_data_size: u64 = get_return_data()
            .ok_or(ProgramError::InvalidArgument)
            .and_then(|(returning_pubkey, data)| {
                if returning_pubkey != spl_token_2022_id {
                    return Err(ProgramError::InvalidArgument);
                }
                let data: [u8; 8] = data
                    .as_slice()
                    .try_into()
                    .map_err(|_| ProgramError::InvalidArgument)?;
                Ok(u64::from_le_bytes(data))
            })?;

        // Create escrow PDA owned by the SPL token program.
        invoke_signed(
            &system_instruction::create_account(
                payer_account_info.key,
                escrow_account_info.key,
                Rent::default().minimum_balance(account_data_size.try_into().unwrap()),
                account_data_size,
                &spl_token_2022_id,
            ),
            &[payer_account_info.clone(), escrow_account_info.clone()],
            &[hyperlane_token_escrow_pda_seeds!(escrow_bump)],
        )?;

        // And initialize the escrow account.
        invoke(
            &initialize_account(
                &spl_token_2022_id,
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
        invoke_signed(
            &system_instruction::create_account(
                payer_account_info.key,
                ata_payer_account_info.key,
                Rent::default().minimum_balance(0),
                0,
                // Grant ownership to the system program so that the ATA program
                // can call into the system program with the ATA payer as the
                // payer.
                &solana_program::system_program::id(),
            ),
            &[payer_account_info.clone(), ata_payer_account_info.clone()],
            &[hyperlane_token_ata_payer_pda_seeds!(ata_payer_bump)],
        )?;

        Ok(Self {
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
    /// 0. [executable] The spl_token_2022 program.
    /// 1. [] The mint.
    /// 2. [writeable] The token sender's associated token account, from which tokens will be sent.
    /// 3. [] The escrow PDA account.
    fn transfer_in<'a, 'b>(
        _program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let spl_token_2022_id = spl_token_2022::id();

        // Account 0: SPL token 2022 program.
        let spl_token_2022_account_info = next_account_info(accounts_iter)?;
        if spl_token_2022_account_info.key != &spl_token_2022_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_token_2022_account_info.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 1: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.key != &token.plugin_data.mint {
            return Err(ProgramError::IncorrectProgramId);
        }
        if mint_account_info.owner != &spl_token_2022_id {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 2: The sender's associated token account.
        let sender_ata_account_info = next_account_info(accounts_iter)?;
        let expected_sender_associated_token_key = get_associated_token_address_with_program_id(
            sender_wallet_account_info.key,
            mint_account_info.key,
            &spl_token_2022_id,
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
            &spl_token_2022_id,
            sender_ata_account_info.key,
            mint_account_info.key,
            escrow_account_info.key,
            sender_wallet_account_info.key,
            // Multisignatures not supported at the moment.
            &[],
            amount,
            DECIMALS,
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
    /// 0. [executable] SPL token 2022 program.
    /// 1. [executable] SPL associated token account.
    /// 2. [writeable] Mint account.
    /// 3. [writeable] Recipient associated token account.
    /// 4. [writeable] ATA payer PDA account.
    /// 5. [writeable] Escrow account.
    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program_account_info: &'a AccountInfo<'b>,
        recipient_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let spl_token_2022_id = spl_token_2022::id();

        // Account 0: SPL token 2022 program
        let spl_token_2022_account_info = next_account_info(accounts_iter)?;
        if spl_token_2022_account_info.key != &spl_token_2022_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !spl_token_2022_account_info.executable {
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
                &spl_token_2022_id,
            );
        if recipient_ata_account_info.key != &expected_recipient_associated_token_account_key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !recipient_ata_account_info.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Account 4: ATA payer PDA account
        let ata_payer_account_info = next_account_info(accounts_iter)?;
        let ata_payer_seeds: &[&[u8]] =
            hyperlane_token_ata_payer_pda_seeds!(token.plugin_data.ata_payer_bump);
        let expected_ata_payer_key = Pubkey::create_program_address(ata_payer_seeds, program_id)?;
        if ata_payer_account_info.key != &expected_ata_payer_key {
            return Err(ProgramError::IncorrectProgramId);
        }

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
                &spl_token_2022_id,
            ),
            &[
                ata_payer_account_info.clone(),
                recipient_ata_account_info.clone(),
                recipient_wallet_account_info.clone(),
                mint_account_info.clone(),
                system_program_account_info.clone(),
                spl_token_2022_account_info.clone(),
            ],
            &[ata_payer_seeds],
        )?;

        // After potentially paying for the ATA creation, we need to make sure
        // the ATA payer still meets the rent-exemption requirements!
        let ata_payer_lamports = ata_payer_account_info.lamports();
        let ata_payer_rent_exemption_requirement = Rent::default().minimum_balance(0);
        if ata_payer_lamports < ata_payer_rent_exemption_requirement {
            return Err(ProgramError::from(Error::AtaBalanceTooLow));
        }

        let transfer_instruction = transfer_checked(
            &spl_token_2022_id,
            escrow_account_info.key,
            mint_account_info.key,
            recipient_ata_account_info.key,
            escrow_account_info.key,
            &[],
            amount,
            DECIMALS,
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

    fn transfer_out_account_metas(
        _program_id: &Pubkey,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        // let (mint_account_key, _mint_bump) =
        //     Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), program_id);

        // let (ata_payer_account_key, _ata_payer_bump) =
        //     Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);

        // let recipient_associated_token_account = get_associated_token_address_with_program_id(
        //     &Pubkey::new_from_array(token_message.recipient().into()),
        //     &mint_account_key,
        //     &spl_token_2022::id(),
        // );

        // Ok((
        //     vec![
        //         AccountMeta::new_readonly(spl_token_2022::id(), false).into(),
        //         AccountMeta::new_readonly(spl_associated_token_account::id(), false).into(),
        //         AccountMeta::new(mint_account_key, false).into(),
        //         AccountMeta::new(recipient_associated_token_account, false).into(),
        //         AccountMeta::new(ata_payer_account_key, false).into(),
        //     ],
        //     // The recipient does not need to be writeable
        //     false,
        // ))

        Ok((vec![], false))
    }
}
