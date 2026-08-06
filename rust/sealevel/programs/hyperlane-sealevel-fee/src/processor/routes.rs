//! SetRemoteFeeRoute and RemoveRemoteFeeRoute instruction handlers.

use account_utils::{
    create_pda_account, ensure_no_extraneous_accounts, AccountInfoExt, AccountInitState, SizedData,
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
    accounts::{
        CrossCollateralRoute, CrossCollateralRouteAccount, FeeData, FeeStandingQuotePda,
        FeeStandingQuotePdaAccount, RouteDomain, RouteDomainAccount, WILDCARD_DOMAIN,
    },
    cc_route_pda_seeds,
    error::Error,
    fee_standing_quote_pda_seeds,
    instruction::{RemoveRemoteFeeRoute, SetRemoteFeeRoute},
    route_domain_pda_seeds,
};

use super::common::fetch_fee_account_and_verify_owner;

/// Set or update a remote fee route (owner-only).
/// Creates or updates the route PDA (RouteDomain or CrossCollateralRoute) based on fee_data.
/// Resets the standing quote PDA to empty for the (domain, target_router) pair.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[signer, writable]` Owner.
/// 3. `[writable]` Route PDA (RouteDomain or CrossCollateralRoute).
/// 4. `[writable]` Standing quote PDA (created empty or overwritten to empty).
pub(super) fn process_set_remote_fee_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: SetRemoteFeeRoute,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, fee_account, owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    if data.domain == 0 || data.domain == WILDCARD_DOMAIN {
        return Err(Error::InvalidRouteDomain.into());
    }

    data.fee_data.validate_params()?;

    let domain_le = data.domain.to_le_bytes();

    // Validate target_router against fee_data variant and upsert the route PDA.
    let standing_target_router = match (&fee_account.fee_data, data.target_router) {
        (FeeData::Routing(_), None) => {
            let (expected_key, bump) = Pubkey::find_program_address(
                route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                program_id,
            );
            let account = RouteDomainAccount::new(
                RouteDomain {
                    bump_seed: bump,
                    fee_data: data.fee_data,
                    signers: data.signers,
                }
                .into(),
            );

            upsert_route_pda(
                program_id,
                accounts_iter,
                expected_key,
                &account,
                route_domain_pda_seeds!(fee_account_info.key, &domain_le, bump),
                owner_info,
                system_program_info,
            )?;

            hyperlane_core::H256::zero()
        }
        (FeeData::CrossCollateralRouting(_), Some(target_router)) => {
            if target_router.is_zero() {
                return Err(Error::ZeroTargetRouterNotAllowed.into());
            }

            let (expected_key, bump) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &domain_le, target_router),
                program_id,
            );
            let account = CrossCollateralRouteAccount::new(
                CrossCollateralRoute {
                    bump_seed: bump,
                    fee_data: data.fee_data,
                    signers: data.signers,
                }
                .into(),
            );

            upsert_route_pda(
                program_id,
                accounts_iter,
                expected_key,
                &account,
                cc_route_pda_seeds!(fee_account_info.key, &domain_le, target_router, bump),
                owner_info,
                system_program_info,
            )?;

            target_router
        }
        (FeeData::Routing(_) | FeeData::Leaf(_), Some(_)) => {
            return Err(Error::NotCrossCollateralRoutingFeeData.into());
        }
        (FeeData::CrossCollateralRouting(_), None) => {
            return Err(Error::NotRoutingFeeData.into());
        }
        (FeeData::Leaf(_), None) => {
            return Err(Error::NotRoutingFeeData.into());
        }
    };

    // Reset standing quote PDA to empty.
    reset_standing_quote_pda(
        program_id,
        accounts_iter,
        fee_account_info.key,
        data.domain,
        standing_target_router,
        owner_info,
        system_program_info,
    )?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    msg!("Set remote fee route for domain {}", data.domain);
    Ok(())
}

/// Remove a remote fee route, closing the route PDA (owner-only).
/// Also closes any standing quote PDA for the (domain, target_router) pair.
///
/// Accounts:
/// 0. `[]` Fee account.
/// 1. `[signer, writable]` Owner (receives rent refund).
/// 2. `[writable]` Route PDA.
/// 3. `[writable]` Standing quote PDA (closed if it exists).
pub(super) fn process_remove_remote_fee_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: RemoveRemoteFeeRoute,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let (fee_account_info, fee_account, owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    let domain_le = data.domain.to_le_bytes();

    // Validate target_router against fee_data variant and remove the route PDA.
    let standing_target_router = match (&fee_account.fee_data, data.target_router) {
        (FeeData::Routing(_), None) => {
            let (expected_key, _) = Pubkey::find_program_address(
                route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                program_id,
            );
            remove_route_pda(program_id, accounts_iter, expected_key, owner_info)?;

            hyperlane_core::H256::zero()
        }
        (FeeData::CrossCollateralRouting(_), Some(target_router)) => {
            if target_router.is_zero() {
                return Err(Error::ZeroTargetRouterNotAllowed.into());
            }

            let (expected_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &domain_le, target_router),
                program_id,
            );
            remove_route_pda(program_id, accounts_iter, expected_key, owner_info)?;

            target_router
        }
        (FeeData::Routing(_) | FeeData::Leaf(_), Some(_)) => {
            return Err(Error::NotCrossCollateralRoutingFeeData.into());
        }
        (FeeData::CrossCollateralRouting(_), None) => {
            return Err(Error::NotRoutingFeeData.into());
        }
        (FeeData::Leaf(_), None) => {
            return Err(Error::NotRoutingFeeData.into());
        }
    };

    // Close standing quote PDA if it exists.
    try_close_standing_quote_pda(
        program_id,
        accounts_iter,
        fee_account_info.key,
        data.domain,
        standing_target_router,
        owner_info,
    )?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    msg!("Removed remote fee route for domain {}", data.domain);
    Ok(())
}

// --- Helpers ---

/// Removes a route PDA (RouteDomain or CrossCollateralRoute).
/// Verifies the PDA key matches `expected_key`, checks ownership, and closes it.
fn remove_route_pda<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    expected_key: Pubkey,
    owner_info: &'a AccountInfo<'b>,
) -> ProgramResult {
    let route_pda_info = next_account_info(accounts_iter)?;
    if *route_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }
    if route_pda_info.owner != program_id {
        return Err(Error::RouteNotFound.into());
    }

    route_pda_info.close_account(owner_info)
}

/// Creates or updates a route PDA (RouteDomain or CrossCollateralRoute).
/// If the PDA is uninitialized, creates it with `create_pda_account`.
/// If it already exists, updates it via `store_with_rent_exempt_realloc`.
fn upsert_route_pda<'a, 'b, T: account_utils::Data + SizedData>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    expected_key: Pubkey,
    account: &account_utils::AccountData<T>,
    signer_seeds: &[&[u8]],
    owner_info: &'a AccountInfo<'b>,
    system_program_info: &'a AccountInfo<'b>,
) -> ProgramResult {
    let route_pda_info = next_account_info(accounts_iter)?;
    if *route_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }

    match route_pda_info.init_state(program_id) {
        AccountInitState::Uninitialized => {
            let rent = Rent::get()?;
            create_pda_account(
                owner_info,
                &rent,
                SizedData::size(account),
                program_id,
                system_program_info,
                route_pda_info,
                signer_seeds,
            )?;
            account.store(route_pda_info, false)?;
        }
        AccountInitState::Initialized => {
            account.store_with_rent_exempt_realloc(
                route_pda_info,
                &Rent::get()?,
                owner_info,
                system_program_info,
            )?;
        }
        AccountInitState::OwnerMismatch => {
            return Err(ProgramError::IncorrectProgramId);
        }
    }

    Ok(())
}

/// Resets a standing quote PDA to empty (creates if new, overwrites if existing).
/// Ensures a clean slate for standing quotes after route changes.
fn reset_standing_quote_pda<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    fee_account_key: &Pubkey,
    domain: u32,
    target_router: hyperlane_core::H256,
    owner_info: &'a AccountInfo<'b>,
    system_program_info: &'a AccountInfo<'b>,
) -> ProgramResult {
    let domain_le = domain.to_le_bytes();
    let (expected_key, bump) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_key, &domain_le, target_router),
        program_id,
    );

    let empty = FeeStandingQuotePdaAccount::new(
        FeeStandingQuotePda {
            bump_seed: bump,
            quotes: std::collections::BTreeMap::new(),
        }
        .into(),
    );

    upsert_route_pda(
        program_id,
        accounts_iter,
        expected_key,
        &empty,
        fee_standing_quote_pda_seeds!(fee_account_key, &domain_le, target_router, bump),
        owner_info,
        system_program_info,
    )
}

/// Closes a standing quote PDA if it exists (program-owned).
/// Skips if uninitialized (system-owned).
fn try_close_standing_quote_pda<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    fee_account_key: &Pubkey,
    domain: u32,
    target_router: hyperlane_core::H256,
    owner_info: &'a AccountInfo<'b>,
) -> ProgramResult {
    let standing_pda_info = next_account_info(accounts_iter)?;
    let domain_le = domain.to_le_bytes();
    let (expected_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_key, &domain_le, target_router),
        program_id,
    );
    if *standing_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Close if program-owned; skip if system-owned (never created).
    if standing_pda_info.owner == program_id && !standing_pda_info.data_is_empty() {
        standing_pda_info.close_account(owner_info)?;
    }

    Ok(())
}
