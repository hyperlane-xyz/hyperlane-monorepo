//! Fee program state processor.

use std::collections::BTreeSet;

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

use access_control::AccessControl;
use account_utils::{create_pda_account, verify_account_uninitialized, SizedData};

use crate::{
    accounts::{FeeAccount, FeeAccountData, FeeData},
    error::Error,
    fee_account_pda_seeds,
    fee_math::FeeParams,
    instruction::{InitFee, Instruction},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Entrypoint for the fee program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match Instruction::from_instruction_data(instruction_data)? {
        Instruction::InitFee(data) => process_init_fee(program_id, accounts, data),
        Instruction::QuoteFee(_) => todo!("QuoteFee"),
        Instruction::SetRoute(_) => todo!("SetRoute"),
        Instruction::RemoveRoute(_) => todo!("RemoveRoute"),
        Instruction::SetCrossCollateralRoute(_) => todo!("SetCrossCollateralRoute"),
        Instruction::RemoveCrossCollateralRoute(_) => todo!("RemoveCrossCollateralRoute"),
        Instruction::UpdateFeeParams(params) => {
            process_update_fee_params(program_id, accounts, params)
        }
        Instruction::SetBeneficiary(beneficiary) => {
            process_set_beneficiary(program_id, accounts, beneficiary)
        }
        Instruction::TransferOwnership(new_owner) => {
            process_transfer_ownership(program_id, accounts, new_owner)
        }
        Instruction::AddQuoteSigner { .. } => todo!("AddQuoteSigner"),
        Instruction::RemoveQuoteSigner { .. } => todo!("RemoveQuoteSigner"),
        Instruction::SetMinIssuedAt { .. } => todo!("SetMinIssuedAt"),
        Instruction::SubmitQuote(_) => todo!("SubmitQuote"),
        Instruction::CloseTransientQuote => todo!("CloseTransientQuote"),
        Instruction::PruneExpiredQuotes { .. } => todo!("PruneExpiredQuotes"),
        Instruction::GetQuoteAccountMetas(_) => todo!("GetQuoteAccountMetas"),
    }
}

/// Initialize a new fee account.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[signer]` Payer.
/// 2. `[writable]` Fee account PDA.
fn process_init_fee(program_id: &Pubkey, accounts: &[AccountInfo], data: InitFee) -> ProgramResult {
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
        return Err(ProgramError::InvalidSeeds);
    }

    let fee_account = FeeAccountData::new(
        FeeAccount {
            bump: fee_account_bump,
            owner: data.owner,
            beneficiary: data.beneficiary,
            fee_data: data.fee_data,
            domain_id: data.domain_id,
            signers: BTreeSet::new(),
            min_issued_at: 0,
            standing_quote_domains: BTreeSet::new(),
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

/// Set the beneficiary on a fee account (owner-only).
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
fn process_set_beneficiary(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_beneficiary: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    fee_account.beneficiary = new_beneficiary;

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Set beneficiary: {}", new_beneficiary);

    Ok(())
}

/// Transfer ownership of a fee account (owner-only).
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
fn process_transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    fee_account.set_owner(new_owner)?;

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Transferred ownership to: {:?}", new_owner);

    Ok(())
}

/// Update the fee params on a Leaf fee account (owner-only).
/// Rejects if the fee account is not FeeData::Leaf.
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
fn process_update_fee_params(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_params: FeeParams,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    match &mut fee_account.fee_data {
        FeeData::Leaf(strategy) => {
            *strategy.params_mut() = new_params;
        }
        _ => {
            return Err(Error::NotLeafFeeData.into());
        }
    }

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Updated fee params");

    Ok(())
}

/// Fetches the fee account and verifies the owner is the signer.
///
/// Accounts consumed:
/// 0. `[writable]` Fee account (owned by this program).
/// 1. `[signer]` Owner.
fn fetch_fee_account_and_verify_owner<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<(&'a AccountInfo<'b>, FeeAccount), ProgramError> {
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    Ok((fee_account_info, fee_account.data))
}
