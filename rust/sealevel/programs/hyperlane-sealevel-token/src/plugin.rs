use crate::error::Error;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, processor::HyperlaneSealevelTokenPlugin,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack as _,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{burn_checked, mint_to_checked};

// TODO make these easily configurable?
pub const REMOTE_DECIMALS: u8 = 18;
pub const DECIMALS: u8 = 8;

/// Seeds relating to the PDA account that acts both as the mint
/// *and* the mint authority.
#[macro_export]
macro_rules! hyperlane_token_mint_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"mint"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"mint", &[$bump_seed]]
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

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct SyntheticPlugin {
    mint: Pubkey,
    mint_bump: u8,
    ata_payer_bump: u8,
}

impl SyntheticPlugin {
    const MINT_ACCOUNT_SIZE: usize = spl_token_2022::state::Mint::LEN;
}

impl HyperlaneSealevelTokenPlugin for SyntheticPlugin {
    /// Initializes the plugin.
    ///
    /// Accounts:
    /// N.     [writable] The mint / mint authority PDA account.
    /// N + 1. [writable] The ATA payer PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        _system_program: &'a AccountInfo<'b>,
        _token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account N + 0: Mint / mint authority
        let mint_account = next_account_info(accounts_iter)?;
        let (mint_key, mint_bump) =
            Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), program_id);
        if &mint_key != mint_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        // Create mint / mint authority PDA.
        // Grant ownership to the SPL token program.
        invoke_signed(
            &system_instruction::create_account(
                payer_account.key,
                mint_account.key,
                Rent::default().minimum_balance(Self::MINT_ACCOUNT_SIZE),
                Self::MINT_ACCOUNT_SIZE.try_into().unwrap(),
                &spl_token_2022::id(),
            ),
            &[payer_account.clone(), mint_account.clone()],
            &[hyperlane_token_mint_pda_seeds!(mint_bump)],
        )?;

        // Account N + 1: ATA payer.
        let ata_payer_account = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) =
            Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);
        if &ata_payer_key != ata_payer_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        // Create the ATA payer.
        // This is a separate PDA because the ATA program requires
        // the payer to have no data in it.
        invoke_signed(
            &system_instruction::create_account(
                payer_account.key,
                ata_payer_account.key,
                Rent::default().minimum_balance(0),
                0,
                // Grant ownership to the system program so that the ATA program
                // can call into the system program with the ATA payer as the
                // payer.
                &solana_program::system_program::id(),
            ),
            &[payer_account.clone(), ata_payer_account.clone()],
            &[hyperlane_token_ata_payer_pda_seeds!(ata_payer_bump)],
        )?;

        Ok(Self {
            mint: mint_key,
            mint_bump: mint_bump,
            ata_payer_bump,
        })
    }

    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // 5. SPL token 2022 program
        let spl_token_2022 = next_account_info(accounts_iter)?;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }

        // 6. mint account
        let mint_account = next_account_info(accounts_iter)?;
        let mint_seeds: &[&[u8]] = hyperlane_token_mint_pda_seeds!(token.plugin_data.mint_bump);
        let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
        if mint_account.key != &expected_mint_key {
            return Err(ProgramError::InvalidArgument);
        }
        if *mint_account.key != token.plugin_data.mint {
            return Err(ProgramError::InvalidArgument);
        }
        if mint_account.owner != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
        }
        if mint_account.owner != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Hmmmmmm should this be enforced?

        // 7. sender associated token account
        let sender_ata = next_account_info(accounts_iter)?;
        let expected_sender_associated_token_account = get_associated_token_address_with_program_id(
            sender_wallet.key,
            mint_account.key,
            &spl_token_2022::id(),
        );
        if sender_ata.key != &expected_sender_associated_token_account {
            return Err(ProgramError::InvalidArgument);
        }

        let burn_ixn = burn_checked(
            &spl_token_2022::id(),
            sender_ata.key,
            mint_account.key,
            sender_wallet.key,
            &[sender_wallet.key],
            amount,
            DECIMALS,
        )?;
        // Sender wallet is expected to have signed this transaction
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

    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Account 5: SPL token 2022 program
        let spl_token_2022 = next_account_info(accounts_iter)?;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }
        // Account 6: SPL associated token account
        let spl_ata = next_account_info(accounts_iter)?;
        if spl_ata.key != &spl_associated_token_account::id() || !spl_ata.executable {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 7: Mint account
        let mint_account = next_account_info(accounts_iter)?;
        let mint_seeds: &[&[u8]] = hyperlane_token_mint_pda_seeds!(token.plugin_data.mint_bump);
        let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
        if mint_account.key != &expected_mint_key {
            return Err(ProgramError::InvalidArgument);
        }
        if mint_account.owner != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 8: Recipient associated token account
        let recipient_ata = next_account_info(accounts_iter)?;
        let expected_recipient_associated_token_account =
            get_associated_token_address_with_program_id(
                recipient_wallet.key,
                mint_account.key,
                &spl_token_2022::id(),
            );
        if recipient_ata.key != &expected_recipient_associated_token_account {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 9: ATA payer PDA account
        let ata_payer_account = next_account_info(accounts_iter)?;
        let ata_payer_seeds: &[&[u8]] =
            hyperlane_token_ata_payer_pda_seeds!(token.plugin_data.ata_payer_bump);
        let expected_ata_payer_account =
            Pubkey::create_program_address(ata_payer_seeds, program_id)?;
        if ata_payer_account.key != &expected_ata_payer_account {
            return Err(ProgramError::InvalidArgument);
        }

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        // Create and init (this does both) associated token account if necessary.
        invoke_signed(
            &create_associated_token_account_idempotent(
                ata_payer_account.key,
                // payer_account.key,
                recipient_wallet.key,
                mint_account.key,
                &spl_token_2022::id(),
            ),
            &[
                ata_payer_account.clone(),
                // token_account.clone(),
                // mint_account.clone(),
                // solana_program::instruction::AccountMeta::new_readonly(*mint_account.key, true),
                // payer_account.clone(),
                recipient_ata.clone(),
                recipient_wallet.clone(),
                mint_account.clone(),
                system_program.clone(),
                spl_token_2022.clone(),
            ],
            &[ata_payer_seeds, mint_seeds],
        )?;

        // After potentially paying for the ATA creation, we need to make sure
        // the ATA payer still meets the rent-exemption requirements!
        let ata_payer_lamports = ata_payer_account.lamports();
        let ata_payer_rent_exemption_requirement = Rent::default().minimum_balance(0);
        if ata_payer_lamports < ata_payer_rent_exemption_requirement {
            return Err(ProgramError::from(Error::AtaBalanceTooLow));
        }

        // Mints new tokens to an account.  The native mint does not support
        // minting.
        //
        // Accounts expected by this instruction:
        //
        //   * Single authority
        //   0. `[writable]` The mint.
        //   1. `[writable]` The account to mint tokens to.
        //   2. `[signer]` The mint's minting authority.
        //
        //   * Multisignature authority
        //   0. `[writable]` The mint.
        //   1. `[writable]` The account to mint tokens to.
        //   2. `[]` The mint's multisignature mint-tokens authority.
        //   3. ..3+M `[signer]` M signer accounts.
        let mint_ixn = mint_to_checked(
            &spl_token_2022::id(),
            mint_account.key,
            recipient_ata.key,
            mint_account.key,
            &[],
            amount,
            DECIMALS,
        )?;
        invoke_signed(
            &mint_ixn,
            &[
                mint_account.clone(),
                recipient_ata.clone(),
                mint_account.clone(),
            ],
            &[hyperlane_token_mint_pda_seeds!(token.plugin_data.mint_bump)],
        )?;

        Ok(())
    }
}
