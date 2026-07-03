//! InitFee instruction handler.

use account_utils::{
    create_pda_account, ensure_no_extraneous_accounts, verify_account_uninitialized, SizedData,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{FeeAccount, FeeAccountData, FeeData},
    fee_account_pda_seeds,
    instruction::InitFee,
};

/// Initialize a new fee account.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[signer]` Payer.
/// 2. `[writable]` Fee account PDA.
pub(super) fn process_init_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: InitFee,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Fee account PDA.
    let fee_account_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(fee_account_info)?;
    let (fee_account_key, fee_account_bump) =
        Pubkey::find_program_address(fee_account_pda_seeds!(data.salt), program_id);
    if *fee_account_info.key != fee_account_key {
        return Err(ProgramError::InvalidArgument);
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    if let FeeData::Leaf(ref cfg) = data.fee_data {
        cfg.strategy.validate_params()?;
    }

    let fee_account = FeeAccountData::new(
        FeeAccount {
            bump_seed: fee_account_bump,
            owner: Some(*payer_info.key),
            beneficiary: data.beneficiary,
            domain_id: data.domain_id,
            min_issued_at: 0,
            fee_data: data.fee_data,
        }
        .into(),
    );

    let rent = Rent::get()?;

    create_pda_account(
        payer_info,
        &rent,
        SizedData::size(&fee_account),
        program_id,
        system_program_info,
        fee_account_info,
        fee_account_pda_seeds!(data.salt, fee_account_bump),
    )?;

    fee_account.store(fee_account_info, false)?;

    msg!("Initialized fee account: {}", fee_account_key);

    Ok(())
}
