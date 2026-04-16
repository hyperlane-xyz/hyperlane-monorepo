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
    accounts::{FeeAccount, FeeAccountData, FeeData, RouteDomain, RouteDomainAccount},
    error::Error,
    fee_account_pda_seeds,
    fee_math::FeeParams,
    instruction::{InitFee, Instruction, SetRoute},
    route_domain_pda_seeds,
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
        Instruction::SetRoute(data) => process_set_route(program_id, accounts, data),
        Instruction::RemoveRoute(domain) => process_remove_route(program_id, accounts, domain),
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

    ensure_no_extraneous_accounts(accounts_iter)?;

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
fn process_transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account) =
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
fn process_update_fee_params(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_params: FeeParams,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

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

/// Set or update a per-domain route (owner-only).
/// Creates the RouteDomain PDA if it doesn't exist, or updates it if it does.
/// Requires the fee account to be FeeData::Routing.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[signer, writable]` Owner.
/// 3. `[writable]` RouteDomain PDA.
fn process_set_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: SetRoute,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1 + 2: Fee account (read-only) + owner (signer).
    let (fee_account_info, fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    if !matches!(fee_account.fee_data, FeeData::Routing) {
        return Err(Error::NotRoutingFeeData.into());
    }

    // Account 3: RouteDomain PDA.
    let route_pda_info = next_account_info(accounts_iter)?;
    let domain_le = data.domain.to_le_bytes();
    let (expected_route_key, route_bump) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_account_info.key, &domain_le),
        program_id,
    );
    if *route_pda_info.key != expected_route_key {
        return Err(ProgramError::InvalidSeeds);
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    let route_domain = RouteDomainAccount::new(
        RouteDomain {
            bump: route_bump,
            fee_data: data.fee_data,
        }
        .into(),
    );

    // Create the PDA if uninitialized, or verify ownership if it exists.
    if route_pda_info.data_is_empty() && route_pda_info.owner == &system_program::ID {
        let owner_info = &accounts[2];
        let rent = Rent::get()?;
        create_pda_account(
            owner_info,
            &rent,
            SizedData::size(&route_domain),
            program_id,
            system_program_info,
            route_pda_info,
            route_domain_pda_seeds!(fee_account_info.key, &domain_le, route_bump),
        )?;
    } else if route_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    route_domain.store(route_pda_info, false)?;

    msg!("Set route for domain {}", data.domain);

    Ok(())
}

/// Remove a per-domain route, closing the RouteDomain PDA (owner-only).
/// Returns rent to the owner. Requires the fee account to be FeeData::Routing.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[signer, writable]` Owner (receives rent refund).
/// 3. `[writable]` RouteDomain PDA.
fn process_remove_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let _system_program_info = next_account_info(accounts_iter)?;
    if *_system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1 + 2: Fee account + owner.
    let (fee_account_info, fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    if !matches!(fee_account.fee_data, FeeData::Routing) {
        return Err(Error::NotRoutingFeeData.into());
    }

    // Account 3: RouteDomain PDA.
    let route_pda_info = next_account_info(accounts_iter)?;
    let domain_le = domain.to_le_bytes();
    let (expected_route_key, _) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_account_info.key, &domain_le),
        program_id,
    );
    if *route_pda_info.key != expected_route_key {
        return Err(ProgramError::InvalidSeeds);
    }
    if route_pda_info.owner != program_id {
        return Err(Error::RouteNotFound.into());
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    // Close the PDA: drain lamports to owner, zero data, reassign to system program.
    let owner_info = &accounts[2];
    close_pda(route_pda_info, owner_info)?;

    msg!("Removed route for domain {}", domain);

    Ok(())
}

// --- Helpers ---

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

/// Errors if there are remaining accounts in the iterator.
fn ensure_no_extraneous_accounts(
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
) -> ProgramResult {
    if accounts_iter.next().is_some() {
        return Err(Error::ExtraneousAccount.into());
    }
    Ok(())
}

/// Closes a PDA account by draining lamports, zeroing data, and reassigning to the system program.
fn close_pda(pda_info: &AccountInfo, recipient_info: &AccountInfo) -> ProgramResult {
    let lamports = pda_info.lamports();
    **pda_info.try_borrow_mut_lamports()? = 0;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    pda_info.data.borrow_mut().fill(0);
    pda_info.assign(&system_program::ID);
    Ok(())
}
