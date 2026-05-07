//! SetQuoteSigner instruction handler.

use std::collections::BTreeSet;

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
    accounts::{CrossCollateralRouteAccount, FeeAccountData, FeeData, RouteDomainAccount},
    cc_route_pda_seeds,
    error::Error,
    instruction::{RouteKey, SetQuoteSignerOperation},
    route_domain_pda_seeds,
};

use super::common::fetch_fee_account_and_verify_owner;

/// Add an authorized offchain quote signer (owner-only).
/// Reallocs the fee account if it grows.
///
/// Add an offchain quote signer (owner-only).
/// Dispatches by route key: None → FeeAccount (Leaf), Some → route PDA.
///
/// Accounts (route = None / Leaf):
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account.
/// 2. `[signer, writable]` Owner.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account (writable for Leaf; readonly for routed modes).
/// 2. `[signer, writable]` Owner.
/// 3. `[writable]` Route PDA (only for Routing/CC modes).
pub(super) fn process_set_quote_signer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    operation: SetQuoteSignerOperation,
    route: Option<RouteKey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, mut fee_account, owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    let signer = operation.signer();
    match route {
        None => {
            ensure_no_extraneous_accounts(accounts_iter)?;

            let FeeData::Leaf(cfg) = &mut fee_account.fee_data else {
                return Err(Error::NotLeafFeeData.into());
            };

            // Leaf requires signers to be configured (Some) — unlike route PDAs which
            // auto-create. This check runs before apply_signer_op so Add cannot
            // silently create signers on an unconfigured Leaf.
            cfg.signers
                .as_ref()
                .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?;
            apply_signer_op(&mut cfg.signers, &operation);

            FeeAccountData::new(fee_account.into()).store_with_rent_exempt_realloc(
                fee_account_info,
                &Rent::get()?,
                owner_info,
                system_program_info,
            )?;
        }
        Some(RouteKey::Domain(domain)) => {
            if !matches!(fee_account.fee_data, FeeData::Routing(_)) {
                return Err(Error::NotRoutingFeeData.into());
            }

            let route_pda_info = next_account_info(accounts_iter)?;
            ensure_no_extraneous_accounts(accounts_iter)?;

            let domain_le = domain.to_le_bytes();
            let (expected_key, _) = Pubkey::find_program_address(
                route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                program_id,
            );
            if *route_pda_info.key != expected_key {
                return Err(ProgramError::InvalidArgument);
            }
            if route_pda_info.owner != program_id {
                return Err(ProgramError::IncorrectProgramId);
            }

            let mut route_domain =
                RouteDomainAccount::fetch(&mut &route_pda_info.data.borrow()[..])?
                    .into_inner()
                    .data;
            apply_signer_op(&mut route_domain.signers, &operation);
            RouteDomainAccount::new(route_domain.into()).store_with_rent_exempt_realloc(
                route_pda_info,
                &Rent::get()?,
                owner_info,
                system_program_info,
            )?;
        }
        Some(RouteKey::CrossCollateral {
            destination,
            target_router,
        }) => {
            if !matches!(fee_account.fee_data, FeeData::CrossCollateralRouting(_)) {
                return Err(Error::NotCrossCollateralRoutingFeeData.into());
            }

            let cc_pda_info = next_account_info(accounts_iter)?;
            ensure_no_extraneous_accounts(accounts_iter)?;

            let dest_le = destination.to_le_bytes();
            let (expected_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &dest_le, target_router),
                program_id,
            );
            if *cc_pda_info.key != expected_key {
                return Err(ProgramError::InvalidArgument);
            }
            if cc_pda_info.owner != program_id {
                return Err(ProgramError::IncorrectProgramId);
            }

            let mut cc_route =
                CrossCollateralRouteAccount::fetch(&mut &cc_pda_info.data.borrow()[..])?
                    .into_inner()
                    .data;
            apply_signer_op(&mut cc_route.signers, &operation);
            CrossCollateralRouteAccount::new(cc_route.into()).store_with_rent_exempt_realloc(
                cc_pda_info,
                &Rent::get()?,
                owner_info,
                system_program_info,
            )?;
        }
    }

    msg!("SetQuoteSigner: {}", signer);

    Ok(())
}

/// Applies a signer operation to an optional signer set.
/// Creates the set on Add if it doesn't exist; no-op on Remove if None.
fn apply_signer_op(signers: &mut Option<BTreeSet<H160>>, operation: &SetQuoteSignerOperation) {
    match operation {
        SetQuoteSignerOperation::Add(s) => {
            signers.get_or_insert_with(BTreeSet::new).insert(*s);
        }
        SetQuoteSignerOperation::Remove(s) => {
            if let Some(set) = signers {
                set.remove(s);
            }
        }
    }
}
