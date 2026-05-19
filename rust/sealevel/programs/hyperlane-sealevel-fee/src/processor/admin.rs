//! Owner-only mutators on a fee account: beneficiary, ownership transfer, leaf
//! params, min_issued_at, and wildcard signers.

use std::collections::BTreeSet;

use access_control::AccessControl;
use account_utils::ensure_no_extraneous_accounts;
use hyperlane_core::H160;
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
    accounts::{FeeAccountData, FeeData},
    error::Error,
    fee_math::FeeParams,
};

use super::common::fetch_fee_account_and_verify_owner;

/// Set the beneficiary on a fee account (owner-only).
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
pub(super) fn process_set_beneficiary(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_beneficiary: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account, _owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

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
pub(super) fn process_transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account, _owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

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
pub(super) fn process_update_fee_params(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_params: FeeParams,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account, _owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    match &mut fee_account.fee_data {
        FeeData::Leaf(cfg) => {
            *cfg.strategy.params_mut() = new_params;
            cfg.strategy.validate_params()?;
        }
        _ => {
            return Err(Error::NotLeafFeeData.into());
        }
    }

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Updated fee params");

    Ok(())
}

/// Set the minimum issued_at threshold for standing quote validation (owner-only).
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
pub(super) fn process_set_min_issued_at(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    min_issued_at: i64,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account, _owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    // Monotonic: cannot move backward (prevents un-revoking previously revoked quotes).
    if min_issued_at < fee_account.min_issued_at {
        return Err(Error::MinIssuedAtMustBeMonotonic.into());
    }

    fee_account.min_issued_at = min_issued_at;

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Set min_issued_at: {}", min_issued_at);

    Ok(())
}

/// Set wildcard quote signers for Routing or CrossCollateralRouting fee accounts (owner-only).
/// Mutates the wildcard_signers field inside the FeeData variant.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account (fee_data must be Routing or CrossCollateralRouting).
/// 2. `[signer, writable]` Owner.
pub(super) fn process_set_wildcard_quote_signers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    signers: BTreeSet<H160>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, mut fee_account, owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    match &mut fee_account.fee_data {
        FeeData::Leaf(_) => return Err(Error::WildcardSignersNotApplicable.into()),
        FeeData::Routing(cfg) => cfg.wildcard_signers = signers,
        FeeData::CrossCollateralRouting(cfg) => cfg.wildcard_signers = signers,
    }

    FeeAccountData::new(fee_account.into()).store_with_rent_exempt_realloc(
        fee_account_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    msg!("Set wildcard quote signers");

    Ok(())
}
