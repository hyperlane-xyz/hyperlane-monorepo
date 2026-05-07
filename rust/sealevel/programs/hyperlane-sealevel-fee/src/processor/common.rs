//! Shared helpers used by multiple instruction handlers.

use access_control::AccessControl;
use account_utils::{AccountInfoExt, AccountInitState};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::accounts::{FeeAccount, FeeAccountData};

/// Fetches the fee account and verifies the owner is the signer.
///
/// Accounts consumed:
/// 0. `[writable]` Fee account (owned by this program).
/// 1. `[signer]` Owner.
pub(super) fn fetch_fee_account_and_verify_owner<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<(&'a AccountInfo<'b>, FeeAccount, &'a AccountInfo<'b>), ProgramError> {
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    Ok((fee_account_info, fee_account.data, owner_info))
}

/// Verifies an optional PDA account is either uninitialized (system-owned, empty)
/// or owned by this program. Errors if owned by a different program.
pub(super) fn verify_optional_pda_owner(
    account_info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    match account_info.init_state(program_id) {
        AccountInitState::Uninitialized | AccountInitState::Initialized => Ok(()),
        AccountInitState::OwnerMismatch => Err(ProgramError::IncorrectProgramId),
    }
}
