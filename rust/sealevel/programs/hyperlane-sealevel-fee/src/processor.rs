//! Fee program state processor.

use std::collections::BTreeSet;

use hyperlane_core::H160;

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use access_control::AccessControl;
use account_utils::{
    create_pda_account, ensure_no_extraneous_accounts, verify_account_uninitialized,
    AccountInfoExt, AccountInitState, SizedData,
};
use quote_verifier::SvmSignedQuote;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

use crate::{
    accounts::{
        CcFeeQuoteContext, CrossCollateralRoute, CrossCollateralRouteAccount, FeeAccount,
        FeeAccountData, FeeData, FeeQuoteContext, FeeStandingQuotePda, FeeStandingQuotePdaAccount,
        FeeStandingQuoteValue, QuoteContext, RouteDomain, RouteDomainAccount,
        StandingQuoteAuthScope, TransientQuote, TransientQuoteAccount, DEFAULT_ROUTER,
        TRANSIENT_QUOTE_DISCRIMINATOR, WILDCARD_DOMAIN, WILDCARD_RECIPIENT,
    },
    cc_route_pda_seeds,
    error::Error,
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    fee_standing_quote_pda_seeds,
    instruction::{
        GetQuoteAccountMetas, GetSubmitQuoteAccountMetas, InitFee, Instruction, QuoteFee,
        RemoveRemoteFeeRoute, RouteKey, SetQuoteSignerOperation, SetRemoteFeeRoute,
    },
    route_domain_pda_seeds, transient_quote_pda_seeds,
};

use quote_verifier::{QuoteValidationError, ValidatableQuote};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Entrypoint for the fee program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Universal version query — discriminator-based, independent of instruction enum.
    if package_versioned::is_get_program_version(instruction_data) {
        return package_versioned::process_get_program_version::<FeeProgram>();
    }

    match Instruction::from_instruction_data(instruction_data)? {
        Instruction::InitFee(data) => process_init_fee(program_id, accounts, data),
        Instruction::QuoteFee(data) => process_quote_fee(program_id, accounts, data),
        Instruction::SetRemoteFeeRoute(data) => {
            process_set_remote_fee_route(program_id, accounts, data)
        }
        Instruction::RemoveRemoteFeeRoute(data) => {
            process_remove_remote_fee_route(program_id, accounts, data)
        }
        Instruction::UpdateFeeParams(params) => {
            process_update_fee_params(program_id, accounts, params)
        }
        Instruction::SetBeneficiary(beneficiary) => {
            process_set_beneficiary(program_id, accounts, beneficiary)
        }
        Instruction::TransferOwnership(new_owner) => {
            process_transfer_ownership(program_id, accounts, new_owner)
        }
        Instruction::SetQuoteSigner { operation, route } => {
            process_set_quote_signer(program_id, accounts, operation, route)
        }
        Instruction::SetMinIssuedAt { min_issued_at } => {
            process_set_min_issued_at(program_id, accounts, min_issued_at)
        }
        Instruction::SetWildcardQuoteSigners { signers } => {
            process_set_wildcard_quote_signers(program_id, accounts, signers)
        }
        Instruction::SubmitQuote(quote) => process_submit_quote(program_id, accounts, quote),
        Instruction::CloseTransientQuote => process_close_transient_quote(program_id, accounts),
        Instruction::PruneExpiredQuotes {
            domain,
            target_router,
        } => process_prune_expired_quotes(program_id, accounts, domain, target_router),
        Instruction::GetQuoteAccountMetas(data) => {
            process_get_quote_account_metas(program_id, accounts, data)
        }
        Instruction::GetSubmitQuoteAccountMetas(data) => {
            process_get_submit_quote_account_metas(program_id, accounts, data)
        }
    }
}

/// Marker type for PackageVersioned trait implementation.
pub struct FeeProgram;

impl package_versioned::PackageVersioned for FeeProgram {}

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
            fee_data: data.fee_data,
            domain_id: data.domain_id,
            min_issued_at: 0,
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

/// Quote the fee for a transfer.
/// Cascade: transient quote → domain standing quote → wildcard standing quote → on-chain.
/// Returns fee amount as u64 LE via set_return_data.
///
/// Accounts:
/// 0. `[]` Fee account.
/// 1. `[writable]` Payer (for transient quote autoclose).
/// 2. `[writable]` Transient quote PDA (optional — detected by TransientQuote discriminator, writable for autoclose).
///
/// If transient PDA is present:
///     3. `[]` Domain standing quote PDA (always present, may be uninitialized).
///     4. `[]` Wildcard standing quote PDA (always present, may be uninitialized).
///
/// If transient PDA is absent:
///     2. `[]` Domain standing quote PDA.
///     3. `[]` Wildcard standing quote PDA.
///
/// For Routing mode, additionally:
///   N+1. `[]` RouteDomain PDA for the destination.
/// For CrossCollateralRouting mode, additionally:
///   N+1. `[]` CC route PDA for (destination, target_router) — may be uninitialized.
///   N+2. `[]` CC route PDA for (destination, DEFAULT_ROUTER) — may be uninitialized.
fn process_quote_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: QuoteFee,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Fee account.
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    // Account 1: Payer (must be signer — receives lamports on transient autoclose).
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Cache clock for the cascade — avoids redundant syscalls.
    let clock = Clock::get()?;

    // Resolve target_router for standing quote PDA derivation.
    // Used both for slot 2 dispatch and the standing-quote cascade below.
    let standing_target_router = match &fee_account.fee_data {
        FeeData::CrossCollateralRouting(_) => data.target_router,
        _ => hyperlane_core::H256::zero(),
    };

    // Pre-derive the expected domain standing PDA key for slot 2 disambiguation.
    let domain_le = data.destination_domain.to_le_bytes();
    let (expected_domain_standing_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
        program_id,
    );

    // Account 2: Either transient quote PDA or domain standing quote PDA.
    // Disambiguate by key, not discriminator: an uninitialized account has no
    // discriminator, so without a key check the layout becomes ambiguous. The
    // SDK always emits the transient slot when scoped_salt = Some(...) and omits
    // it otherwise — this contract is enforced here.
    let next_info = next_account_info(accounts_iter)?;
    let (transient_info, domain_quotes_info, wildcard_quotes_info) =
        if *next_info.key == expected_domain_standing_key {
            // No transient slot. Slot 2 is the domain standing PDA.
            let wildcard_quotes_info = next_account_info(accounts_iter)?;
            (None, next_info, wildcard_quotes_info)
        } else {
            // Caller declared a transient slot. The PDA must be initialized with
            // the TransientQuote discriminator, otherwise the layout is invalid.
            if !is_initialized_transient_quote(next_info, program_id)? {
                return Err(Error::InvalidTransientSlot.into());
            }
            let domain_quotes_info = next_account_info(accounts_iter)?;
            let wildcard_quotes_info = next_account_info(accounts_iter)?;
            (Some(next_info), domain_quotes_info, wildcard_quotes_info)
        };

    // Validate ownership of standing quote PDAs.
    verify_optional_pda_owner(domain_quotes_info, program_id)?;
    verify_optional_pda_owner(wildcard_quotes_info, program_id)?;

    // --- Resolve on-chain curve type (always needed) ---

    let (strategy, cc_specific_route_active) = match &fee_account.fee_data {
        FeeData::Leaf(cfg) => {
            ensure_no_extraneous_accounts(accounts_iter)?;
            (cfg.strategy.clone(), false)
        }
        FeeData::Routing(_) => {
            match resolve_routing(
                program_id,
                accounts_iter,
                fee_account_info.key,
                data.destination_domain,
            )? {
                Some(strategy) => {
                    ensure_no_extraneous_accounts(accounts_iter)?;
                    (strategy, false)
                }
                None => {
                    // Unconfigured domain → zero fee (EVM-compatible behavior).
                    ensure_no_extraneous_accounts(accounts_iter)?;
                    set_return_data(&0u64.to_le_bytes());
                    msg!(
                        "QuoteFee (unconfigured route): 0 for amount {}",
                        data.amount
                    );
                    return Ok(());
                }
            }
        }
        FeeData::CrossCollateralRouting(_) => {
            let (strategy, cc_specific_route_active) = resolve_cc_routing(
                program_id,
                accounts_iter,
                fee_account_info.key,
                data.destination_domain,
                &data.target_router,
            )?;
            ensure_no_extraneous_accounts(accounts_iter)?;
            (strategy, cc_specific_route_active)
        }
    };

    // --- Quote cascade: transient → standing → on-chain fallback ---

    // Step 1: Transient quote — override params, compute fee, autoclose.
    // Dispatch the correct context type based on fee data variant.
    if let Some(transient_acct) = transient_info {
        let fee = match &fee_account.fee_data {
            FeeData::CrossCollateralRouting(_) => try_consume_transient_quote::<CcFeeQuoteContext>(
                program_id,
                transient_acct,
                payer_info,
                fee_account_info.key,
                &strategy,
                &data,
                fee_account.min_issued_at,
                &clock,
            )?,
            _ => try_consume_transient_quote::<FeeQuoteContext>(
                program_id,
                transient_acct,
                payer_info,
                fee_account_info.key,
                &strategy,
                &data,
                fee_account.min_issued_at,
                &clock,
            )?,
        };

        if let Some(fee) = fee {
            set_return_data(&fee.to_le_bytes());
            msg!("QuoteFee (transient): {} for amount {}", fee, data.amount);
            return Ok(());
        }
    }

    // Steps 2-3: Domain standing quote → wildcard domain standing quote.
    for (pda_info, domain) in [
        (domain_quotes_info, data.destination_domain),
        (wildcard_quotes_info, crate::accounts::WILDCARD_DOMAIN),
    ] {
        if let Some(fee) = try_resolve_standing_quote(
            program_id,
            pda_info,
            fee_account_info.key,
            domain,
            standing_target_router,
            &strategy,
            &data,
            fee_account.min_issued_at,
            &clock,
            cc_specific_route_active,
        )? {
            set_return_data(&fee.to_le_bytes());
            msg!("QuoteFee (standing): {} for amount {}", fee, data.amount);
            return Ok(());
        }
    }

    // Step 4: On-chain fallback — use resolved curve with on-chain params.
    let fee = strategy.compute_fee(data.amount)?;

    set_return_data(&fee.to_le_bytes());
    msg!("QuoteFee (on-chain): {} for amount {}", fee, data.amount);

    Ok(())
}

/// Checks whether an account is an initialized transient quote PDA.
/// Returns `Ok(true)` only if the account is owned by the program, initialized,
/// and carries the TransientQuote discriminator. Returns `Ok(false)` for
/// uninitialized accounts or initialized accounts with a different discriminator.
/// Returns `Err` if the account is owned by a different program.
fn is_initialized_transient_quote(
    account_info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<bool, ProgramError> {
    match account_info.init_state(program_id) {
        AccountInitState::Uninitialized => Ok(false),
        AccountInitState::OwnerMismatch => Err(ProgramError::IncorrectProgramId),
        AccountInitState::Initialized => {
            // AccountData format: [initialized: bool (1)][discriminator: [u8; 8]][data...]
            let data = account_info.data.borrow();
            if data.len() < 9 {
                return Err(ProgramError::InvalidAccountData);
            }
            let discriminator: [u8; 8] = data[1..9]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?;
            Ok(discriminator == TRANSIENT_QUOTE_DISCRIMINATOR)
        }
    }
}

/// Attempts to consume a transient quote PDA.
/// Generic over the context type (FeeQuoteContext or CcFeeQuoteContext).
/// Validates context match, payer binding, PDA derivation, and expiry.
/// On success: computes fee using on-chain curve + quoted params, autocloses PDA.
#[allow(clippy::too_many_arguments)]
fn try_consume_transient_quote<C: crate::accounts::QuoteContext>(
    program_id: &Pubkey,
    transient_acct: &AccountInfo,
    payer_info: &AccountInfo,
    fee_account_key: &Pubkey,
    strategy: &crate::fee_math::FeeDataStrategy,
    quote_fee_data: &QuoteFee,
    min_issued_at: i64,
    clock: &Clock,
) -> Result<Option<u64>, ProgramError> {
    let transient = TransientQuoteAccount::fetch(&mut &transient_acct.data.borrow()[..])?
        .into_inner()
        .data;

    // Verify payer binding.
    if transient.payer != *payer_info.key {
        return Err(QuoteValidationError::TransientPayerMismatch.into());
    }

    // Re-derive PDA from stored scoped_salt + bump and verify key matches.
    // Uses create_program_address (~150 CU) instead of find_program_address (~1,500 CU)
    // since the bump is already stored in the deserialized, program-owned account.
    let expected_key = Pubkey::create_program_address(
        transient_quote_pda_seeds!(fee_account_key, transient.scoped_salt, transient.bump_seed),
        program_id,
    )
    .map_err(|_| Error::TransientPdaMismatch)?;
    if *transient_acct.key != expected_key {
        return Err(Error::TransientPdaMismatch.into());
    }

    transient.validate_quote(min_issued_at, clock)?;

    // Parse and validate context using the generic context type.
    let ctx = C::try_from_bytes(&transient.context)
        .map_err(|_| QuoteValidationError::TransientContextMismatch)?;
    ctx.validate(quote_fee_data)?;

    // Parse quoted strategy and verify curve variant matches on-chain.
    let quoted_strategy = FeeDataStrategy::try_from(transient.data.as_slice())
        .map_err(|_| Error::InvalidTransientData)?;
    if !quoted_strategy.same_variant(strategy) {
        return Err(Error::CurveVariantMismatch.into());
    }
    let fee = quoted_strategy.compute_fee(quote_fee_data.amount)?;

    // Transient PDA must be writable for autoclose.
    if !transient_acct.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }

    // Autoclose: drain lamports to payer, zero data, reassign to system program.
    transient_acct.close_account(payer_info)?;

    Ok(Some(fee))
}

/// Attempts to resolve a fee from a standing quote PDA.
/// Re-derives the PDA from (fee_account, domain, target_router) to prevent spoofing.
/// Scans for exact recipient match, then wildcard recipient.
/// Validates expiry and min_issued_at. Returns None if PDA is uninitialized
/// or no matching entry found.
#[allow(clippy::too_many_arguments)]
fn try_resolve_standing_quote(
    program_id: &Pubkey,
    standing_pda_info: &AccountInfo,
    fee_account_key: &Pubkey,
    domain: u32,
    target_router: hyperlane_core::H256,
    strategy: &crate::fee_math::FeeDataStrategy,
    quote_fee_data: &QuoteFee,
    min_issued_at: i64,
    clock: &Clock,
    cc_specific_route_active: bool,
) -> Result<Option<u64>, ProgramError> {
    // Re-derive PDA to prevent spoofing from a different fee account or domain.
    let domain_le = domain.to_le_bytes();
    let (expected_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_key, &domain_le, target_router),
        program_id,
    );
    if *standing_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Uninitialized PDA → no standing quotes for this domain.
    match standing_pda_info.init_state(program_id) {
        AccountInitState::Uninitialized => return Ok(None),
        AccountInitState::OwnerMismatch => return Err(ProgramError::IncorrectProgramId),
        AccountInitState::Initialized => {}
    }

    let standing = FeeStandingQuotePdaAccount::fetch(&mut &standing_pda_info.data.borrow()[..])?
        .into_inner()
        .data;

    // Try exact recipient match first, then wildcard.
    for recipient_key in [quote_fee_data.recipient, WILDCARD_RECIPIENT] {
        if let Some(value) = standing.quotes.get(&recipient_key) {
            // A CC exact-domain standing quote may have been authorized earlier via the
            // DEFAULT_ROUTER fallback because no router-specific route existed yet. Once a
            // specific route exists, that quote must no longer apply to the specific route's
            // trust domain, even if the standing quote PDA key still matches.
            if cc_specific_route_active
                && value.auth_scope == StandingQuoteAuthScope::CcDefaultFallback
            {
                continue;
            }

            if value.validate_quote(min_issued_at, clock).is_err() {
                continue;
            }

            // Verify curve variant matches on-chain, then compute fee.
            if !value.fee_data.same_variant(strategy) {
                continue;
            }
            let fee = value.fee_data.compute_fee(quote_fee_data.amount)?;
            return Ok(Some(fee));
        }
    }

    Ok(None)
}

/// Resolves the fee strategy for Routing mode by reading the RouteDomain PDA.
/// Returns None if the route PDA is uninitialized (unconfigured domain).
fn resolve_routing(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    fee_account_key: &Pubkey,
    destination_domain: u32,
) -> Result<Option<crate::fee_math::FeeDataStrategy>, ProgramError> {
    let route_pda_info = next_account_info(accounts_iter)?;

    let domain_le = destination_domain.to_le_bytes();
    let (expected_key, _) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_account_key, &domain_le),
        program_id,
    );
    if *route_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }
    // Unconfigured route: uninitialized (system-owned, empty) → None.
    // Owned by another program → error (consistent with standing PDA pattern).
    match route_pda_info.init_state(program_id) {
        AccountInitState::Uninitialized => return Ok(None),
        AccountInitState::OwnerMismatch => return Err(ProgramError::IncorrectProgramId),
        AccountInitState::Initialized => {}
    }

    let route = RouteDomainAccount::fetch(&mut &route_pda_info.data.borrow()[..])?.into_inner();
    Ok(Some(route.data.fee_data))
}

/// Resolves the fee strategy for CrossCollateralRouting mode.
/// Always consumes both account slots — (destination, target_router) and
/// (destination, DEFAULT_ROUTER) — to match the layout produced by
/// `GetQuoteAccountMetas`. Returns the specific route's strategy if its PDA
/// is initialized, otherwise falls back to the default route's strategy.
fn resolve_cc_routing(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    fee_account_key: &Pubkey,
    destination: u32,
    target_router: &hyperlane_core::H256,
) -> Result<(crate::fee_math::FeeDataStrategy, bool), ProgramError> {
    let dest_le = destination.to_le_bytes();

    let mut chosen: Option<(crate::fee_math::FeeDataStrategy, bool)> = None;
    for (router, is_specific) in [(*target_router, true), (DEFAULT_ROUTER, false)] {
        let pda_info = next_account_info(accounts_iter)?;
        let (expected_key, _) = Pubkey::find_program_address(
            cc_route_pda_seeds!(fee_account_key, &dest_le, router),
            program_id,
        );

        if *pda_info.key != expected_key {
            return Err(ProgramError::InvalidArgument);
        }

        match pda_info.init_state(program_id) {
            AccountInitState::Initialized => {
                if chosen.is_none() {
                    let route =
                        CrossCollateralRouteAccount::fetch(&mut &pda_info.data.borrow()[..])?
                            .into_inner();
                    chosen = Some((route.data.fee_data, is_specific));
                }
                // Specific already took precedence — keep iterating to drain
                // the slot so ensure_no_extraneous_accounts doesn't reject it.
            }
            AccountInitState::Uninitialized => {}
            AccountInitState::OwnerMismatch => return Err(ProgramError::IncorrectProgramId),
        }
    }

    chosen.ok_or_else(|| Error::RouteNotFound.into())
}

/// Verifies an optional PDA account is either uninitialized (system-owned, empty)
/// or owned by this program. Errors if owned by a different program.
fn verify_optional_pda_owner(
    account_info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    match account_info.init_state(program_id) {
        AccountInitState::Uninitialized | AccountInitState::Initialized => Ok(()),
        AccountInitState::OwnerMismatch => Err(ProgramError::IncorrectProgramId),
    }
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
fn process_transfer_ownership(
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
fn process_update_fee_params(
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
fn process_set_quote_signer(
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

/// Set the minimum issued_at threshold for standing quote validation (owner-only).
///
/// Accounts:
/// 0. `[writable]` Fee account.
/// 1. `[signer]` Owner.
fn process_set_min_issued_at(
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
fn process_set_wildcard_quote_signers(
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

/// Submit a signed offchain quote. Creates a transient or standing quote PDA.
///
/// Transient accounts (expiry == issued_at):
/// `[0]` System program, `[1]` Payer (signer), `[2]` Fee account,
/// `[3..N]` Route PDAs, `[N+1]` Transient quote PDA (writable).
///
/// Standing accounts (expiry > issued_at):
/// `[0]` System program, `[1]` Payer (signer), `[2]` Fee account,
/// `[3..N]` Route PDAs, `[N+1]` Standing quote PDA (writable).
fn process_submit_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    quote: SvmSignedQuote,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Payer (must be signer — binds the scoped salt).
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Fee account (read-only, for signer verification).
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    // Validate structural validity, liveness, and freshness.
    let clock = Clock::get()?;
    quote
        .validate_quote_submission(fee_account.min_issued_at, &clock)
        .map_err(Into::<ProgramError>::into)?;

    let issued_at_ts = quote.issued_at_timestamp();
    let expiry_ts = quote.expiry_timestamp();

    // Resolve signers based on fee_data type and destination domain.
    // - Leaf: signers from FeeData::Leaf for all quotes.
    // - Routing exact: signers from RouteDomain PDA.
    // - Routing wildcard: signers from FeeData::Routing.wildcard_signers.
    // - CC exact: signers from resolved CrossCollateralRoute PDA.
    // - CC wildcard: signers from FeeData::CrossCollateralRouting.wildcard_signers.
    // Returns (signers, destination_domain, standing auth scope).
    // destination_domain is extracted from the quote context during signer resolution.
    let (resolved_signers, resolved_destination, resolved_auth_scope): (
        BTreeSet<H160>,
        u32,
        StandingQuoteAuthScope,
    ) = match &fee_account.fee_data {
        FeeData::Leaf(cfg) => {
            let signers = cfg
                .signers
                .as_ref()
                .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?
                .clone();
            let ctx = FeeQuoteContext::try_from_bytes(&quote.context)?;

            (
                signers,
                ctx.destination_domain,
                StandingQuoteAuthScope::Direct,
            )
        }
        FeeData::Routing(_) => {
            let ctx = FeeQuoteContext::try_from_bytes(&quote.context)?;
            if ctx.destination_domain == WILDCARD_DOMAIN {
                let signers = fee_account.fee_data.routing_wildcard_signers()?.clone();

                (signers, WILDCARD_DOMAIN, StandingQuoteAuthScope::Direct)
            } else {
                // Exact domain: auth from RouteDomain PDA.
                let route_pda_info = next_account_info(accounts_iter)?;
                let domain_le = ctx.destination_domain.to_le_bytes();
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

                let route = RouteDomainAccount::fetch(&mut &route_pda_info.data.borrow()[..])?
                    .into_inner()
                    .data;
                let signers = route
                    .signers
                    .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?;
                (
                    signers,
                    ctx.destination_domain,
                    StandingQuoteAuthScope::Direct,
                )
            }
        }
        FeeData::CrossCollateralRouting(_) => {
            let ctx = CcFeeQuoteContext::try_from_bytes(&quote.context)?;
            if ctx.destination_domain == WILDCARD_DOMAIN {
                let signers = fee_account.fee_data.cc_wildcard_signers()?.clone();

                (signers, WILDCARD_DOMAIN, StandingQuoteAuthScope::Direct)
            } else {
                // Exact domain: auth from resolved CC route PDA.
                // Account 3: CC specific route PDA (read-only).
                // Account 4: CC default route PDA (read-only).
                let specific_pda_info = next_account_info(accounts_iter)?;
                let default_pda_info = next_account_info(accounts_iter)?;

                let dest_le = ctx.destination_domain.to_le_bytes();

                // Resolve: specific → default (same cascade as QuoteFee).
                let (resolved_pda_info, auth_scope) = {
                    let (specific_key, _) = Pubkey::find_program_address(
                        cc_route_pda_seeds!(fee_account_info.key, &dest_le, ctx.target_router),
                        program_id,
                    );
                    if *specific_pda_info.key != specific_key {
                        return Err(ProgramError::InvalidArgument);
                    }
                    // Verify ownership: must be fee program or system (uninitialized).
                    verify_optional_pda_owner(specific_pda_info, program_id)?;

                    if specific_pda_info.owner == program_id && !specific_pda_info.data_is_empty() {
                        (specific_pda_info, StandingQuoteAuthScope::Direct)
                    } else {
                        let (default_key, _) = Pubkey::find_program_address(
                            cc_route_pda_seeds!(fee_account_info.key, &dest_le, DEFAULT_ROUTER),
                            program_id,
                        );
                        if *default_pda_info.key != default_key {
                            return Err(ProgramError::InvalidArgument);
                        }
                        verify_optional_pda_owner(default_pda_info, program_id)?;

                        if default_pda_info.owner != program_id || default_pda_info.data_is_empty()
                        {
                            return Err(Error::RouteNotFound.into());
                        }
                        (default_pda_info, StandingQuoteAuthScope::CcDefaultFallback)
                    }
                };

                let route =
                    CrossCollateralRouteAccount::fetch(&mut &resolved_pda_info.data.borrow()[..])?
                        .into_inner()
                        .data;
                let signers = route
                    .signers
                    .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?;
                (signers, ctx.destination_domain, auth_scope)
            }
        }
    };

    // Verify the quote signature against resolved signers.
    quote
        .verify_signer(
            fee_account_info.key,
            fee_account.domain_id,
            payer_info.key,
            &resolved_signers,
        )
        .map_err(Into::<ProgramError>::into)?;

    if quote.is_transient() {
        // Reject wildcard domain transient quotes for routed modes.
        // Transient context matching requires exact destination equality at QuoteFee
        // time, so wildcard transients would always fail and strand rent.
        if !matches!(fee_account.fee_data, FeeData::Leaf(_))
            && resolved_destination == WILDCARD_DOMAIN
        {
            return Err(Error::InvalidStandingQuoteContext.into());
        }

        // Next account: Transient quote PDA.
        let transient_pda_info = next_account_info(accounts_iter)?;

        let scoped_salt = quote.compute_scoped_salt(payer_info.key);
        let (expected_key, transient_bump) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        if *transient_pda_info.key != expected_key {
            return Err(ProgramError::InvalidArgument);
        }
        verify_account_uninitialized(transient_pda_info)?;

        ensure_no_extraneous_accounts(accounts_iter)?;

        let transient = TransientQuoteAccount::new(
            TransientQuote {
                bump_seed: transient_bump,
                payer: *payer_info.key,
                scoped_salt,
                context: quote.context,
                data: quote.data,
                expiry: expiry_ts,
            }
            .into(),
        );

        let rent = Rent::get()?;
        create_pda_account(
            payer_info,
            &rent,
            SizedData::size(&transient),
            program_id,
            system_program_info,
            transient_pda_info,
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt, transient_bump),
        )?;

        transient.store(transient_pda_info, false)?;

        msg!("Submitted transient quote");
    } else {
        // Standing quote: expiry > issued_at. Store in per-domain PDA.

        // Parse context based on FeeData variant.
        // Leaf/Routing: 44B context, target_router = H256::zero() sentinel.
        // CC: 76B context with target_router, reject H256::zero().
        let (destination_domain, recipient, standing_target_router) = match &fee_account.fee_data {
            FeeData::CrossCollateralRouting(_) => {
                let ctx = CcFeeQuoteContext::try_from_bytes(&quote.context)
                    .map_err(|_| Error::InvalidStandingQuoteContext)?;

                if ctx.amount != u64::MAX {
                    return Err(Error::StandingQuoteAmountNotWildcard.into());
                }

                if ctx.target_router == hyperlane_core::H256::zero()
                    || ctx.target_router == crate::accounts::DEFAULT_ROUTER
                {
                    return Err(Error::ZeroTargetRouterNotAllowed.into());
                }

                (ctx.destination_domain, ctx.recipient, ctx.target_router)
            }
            _ => {
                let ctx = FeeQuoteContext::try_from_bytes(&quote.context)
                    .map_err(|_| Error::InvalidStandingQuoteContext)?;

                if ctx.amount != u64::MAX {
                    return Err(Error::StandingQuoteAmountNotWildcard.into());
                }

                (
                    ctx.destination_domain,
                    ctx.recipient,
                    hyperlane_core::H256::zero(),
                )
            }
        };

        // Reject fully-wildcarded standing quotes (wildcard dest + wildcard recipient).
        if destination_domain == crate::accounts::WILDCARD_DOMAIN
            && recipient == crate::accounts::WILDCARD_RECIPIENT
        {
            return Err(QuoteValidationError::FullyWildcardedQuote.into());
        }

        // Parse quoted fee strategy (curve variant + params).
        let quoted_fee_data = FeeDataStrategy::try_from(quote.data.as_slice())
            .map_err(|_| Error::InvalidStandingQuoteData)?;

        // Account 3: Domain standing quote PDA.
        let domain_pda_info = next_account_info(accounts_iter)?;
        let domain_le = destination_domain.to_le_bytes();
        let (expected_domain_key, domain_bump) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
            program_id,
        );
        if *domain_pda_info.key != expected_domain_key {
            return Err(ProgramError::InvalidArgument);
        }

        ensure_no_extraneous_accounts(accounts_iter)?;

        let (is_new_pda, mut standing_pda) = match domain_pda_info.init_state(program_id) {
            AccountInitState::Uninitialized => (
                true,
                FeeStandingQuotePda {
                    bump_seed: domain_bump,
                    quotes: std::collections::BTreeMap::new(),
                },
            ),
            AccountInitState::Initialized => (
                false,
                FeeStandingQuotePdaAccount::fetch(&mut &domain_pda_info.data.borrow()[..])?
                    .into_inner()
                    .data,
            ),
            AccountInitState::OwnerMismatch => {
                return Err(ProgramError::IncorrectProgramId);
            }
        };

        // Insert or update the quote for this recipient.
        let recipient_key = recipient;
        let new_value = FeeStandingQuoteValue {
            issued_at: issued_at_ts,
            expiry: expiry_ts,
            fee_data: quoted_fee_data,
            auth_scope: resolved_auth_scope,
        };

        if let Some(existing) = standing_pda.quotes.get(&recipient_key) {
            if issued_at_ts < existing.issued_at {
                return Err(QuoteValidationError::StaleQuote.into());
            }
            // Equal issued_at → no-op (don't update, don't error).
            if issued_at_ts == existing.issued_at {
                msg!("Standing quote no-op (equal issued_at)");
                return Ok(());
            }
        }

        standing_pda.quotes.insert(recipient_key, new_value);

        let standing_account = FeeStandingQuotePdaAccount::new(standing_pda.into());
        let rent = Rent::get()?;

        if is_new_pda {
            create_pda_account(
                payer_info,
                &rent,
                SizedData::size(&standing_account),
                program_id,
                system_program_info,
                domain_pda_info,
                fee_standing_quote_pda_seeds!(
                    fee_account_info.key,
                    &domain_le,
                    standing_target_router,
                    domain_bump
                ),
            )?;
            standing_account.store(domain_pda_info, false)?;
        } else {
            standing_account.store_with_rent_exempt_realloc(
                domain_pda_info,
                &rent,
                payer_info,
                system_program_info,
            )?;
        }

        msg!(
            "Submitted standing quote for domain {} recipient {}",
            destination_domain,
            recipient_key
        );
    }

    Ok(())
}

/// Close an orphaned transient quote PDA, returning rent to the original payer.
///
/// Accounts:
/// 0. `[]` Fee account.
/// 1. `[writable]` Transient quote PDA.
/// 2. `[signer, writable]` Payer refund (must match stored TransientQuote.payer).
fn process_close_transient_quote(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Fee account (read-only, for PDA derivation).
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Transient quote PDA.
    let transient_pda_info = next_account_info(accounts_iter)?;
    if transient_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let transient = TransientQuoteAccount::fetch(&mut &transient_pda_info.data.borrow()[..])?
        .into_inner()
        .data;

    // Re-derive PDA to verify key before trusting deserialized fields.
    let (expected_key, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_account_info.key, transient.scoped_salt),
        program_id,
    );
    if *transient_pda_info.key != expected_key {
        return Err(Error::TransientPdaMismatch.into());
    }

    // Account 2: Payer refund (must be signer and match stored payer).
    let payer_refund_info = next_account_info(accounts_iter)?;
    if !payer_refund_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *payer_refund_info.key != transient.payer {
        return Err(QuoteValidationError::TransientPayerMismatch.into());
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    transient_pda_info.close_account(payer_refund_info)?;

    msg!("Closed transient quote PDA");

    Ok(())
}

/// Remove expired standing quotes for a domain (owner-only).
/// Closes the domain PDA if empty.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account.
/// 2. `[signer, writable]` Owner.
/// 3. `[writable]` Domain standing quote PDA.
fn process_prune_expired_quotes(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
    target_router: Option<hyperlane_core::H256>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, fee_account, owner_info) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    // Validate target_router against fee_data variant.
    let resolved_router = match (&fee_account.fee_data, target_router) {
        (FeeData::CrossCollateralRouting(_), Some(router)) => router,
        (FeeData::CrossCollateralRouting(_), None) => {
            return Err(Error::NotRoutingFeeData.into());
        }
        (FeeData::Routing(_) | FeeData::Leaf(_), None) => hyperlane_core::H256::zero(),
        (FeeData::Routing(_) | FeeData::Leaf(_), Some(_)) => {
            return Err(Error::NotCrossCollateralRoutingFeeData.into());
        }
    };

    // Account 3: Domain standing quote PDA.
    let domain_pda_info = next_account_info(accounts_iter)?;
    let domain_le = domain.to_le_bytes();
    let (expected_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, resolved_router),
        program_id,
    );
    if *domain_pda_info.key != expected_key {
        return Err(ProgramError::InvalidArgument);
    }
    if domain_pda_info.owner != program_id {
        return Err(Error::RouteNotFound.into());
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    let mut standing = FeeStandingQuotePdaAccount::fetch(&mut &domain_pda_info.data.borrow()[..])?
        .into_inner()
        .data;

    let clock = Clock::get()?;
    standing.quotes.retain(|_, value| {
        clock.unix_timestamp <= value.expiry && value.issued_at >= fee_account.min_issued_at
    });

    if standing.quotes.is_empty() {
        // Close the PDA.
        domain_pda_info.close_account(owner_info)?;

        msg!("Pruned domain {} — PDA closed", domain);
    } else {
        // Re-serialize with remaining entries.
        let remaining = standing.quotes.len();
        FeeStandingQuotePdaAccount::new(standing.into()).store_with_rent_exempt_realloc(
            domain_pda_info,
            &Rent::get()?,
            owner_info,
            system_program_info,
        )?;

        msg!("Pruned domain {} — {} entries remaining", domain, remaining);
    }

    Ok(())
}

/// Simulation-only: returns the required account metas for a QuoteFee call.
/// Derives PDA addresses based on the fee account's FeeData type.
///
/// Accounts:
/// 0. `[]` Fee account.
fn process_get_quote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: GetQuoteAccountMetas,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    ensure_no_extraneous_accounts(accounts_iter)?;

    let mut metas: Vec<SerializableAccountMeta> = Vec::new();

    // Fixed prefix accounts.
    metas.push(SerializableAccountMeta {
        pubkey: *fee_account_info.key,
        is_signer: false,
        is_writable: false,
    });
    // Payer placeholder — actual payer key is not known at simulation time.
    // SDK must replace this with the real payer pubkey.
    metas.push(SerializableAccountMeta {
        pubkey: Pubkey::default(),
        is_signer: true,
        is_writable: true,
    });

    // Transient PDA (if scoped_salt provided).
    if let Some(scoped_salt) = data.scoped_salt {
        let (transient_key, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: transient_key,
            is_signer: false,
            is_writable: true,
        });
    }

    // Standing quote PDAs (domain + wildcard).
    // For CC: include target_router in PDA seeds. For Leaf/Routing: H256::zero() sentinel via macro default.
    let domain_le = data.destination_domain.to_le_bytes();
    let standing_target_router = match &fee_account.fee_data {
        FeeData::CrossCollateralRouting(_) => data.target_router,
        _ => hyperlane_core::H256::zero(),
    };
    let (domain_quotes_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
        program_id,
    );
    metas.push(SerializableAccountMeta {
        pubkey: domain_quotes_key,
        is_signer: false,
        is_writable: false,
    });

    let wildcard_le = crate::accounts::WILDCARD_DOMAIN.to_le_bytes();
    let (wildcard_quotes_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &wildcard_le, standing_target_router),
        program_id,
    );
    metas.push(SerializableAccountMeta {
        pubkey: wildcard_quotes_key,
        is_signer: false,
        is_writable: false,
    });

    // Route-specific PDAs.
    match &fee_account.fee_data {
        FeeData::Leaf(_) => {}
        FeeData::Routing(_) => {
            let (route_key, _) = Pubkey::find_program_address(
                route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: route_key,
                is_signer: false,
                is_writable: false,
            });
        }
        FeeData::CrossCollateralRouting(_) => {
            let dest_le = data.destination_domain.to_le_bytes();
            let (cc_specific_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &dest_le, data.target_router),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: cc_specific_key,
                is_signer: false,
                is_writable: false,
            });

            let (cc_default_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &dest_le, DEFAULT_ROUTER),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: cc_default_key,
                is_signer: false,
                is_writable: false,
            });
        }
    }

    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(metas))
            .map_err(|_| ProgramError::BorshIoError)?,
    );

    Ok(())
}

/// Simulation-only: returns required account metas for a SubmitQuote call.
/// Accounts vary by fee_data type (Leaf vs Routing vs CC) and quote kind (transient vs standing).
///
/// Accounts:
/// 0. `[]` Fee account.
fn process_get_submit_quote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: GetSubmitQuoteAccountMetas,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Fee account.
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    ensure_no_extraneous_accounts(accounts_iter)?;

    let mut metas: Vec<SerializableAccountMeta> = Vec::new();

    // Account 0: System program.
    metas.push(SerializableAccountMeta {
        pubkey: system_program::ID,
        is_signer: false,
        is_writable: false,
    });
    // Account 1: Payer placeholder.
    metas.push(SerializableAccountMeta {
        pubkey: Pubkey::default(),
        is_signer: true,
        is_writable: true,
    });
    // Account 2: Fee account (always read-only for SubmitQuote).
    metas.push(SerializableAccountMeta {
        pubkey: *fee_account_info.key,
        is_signer: false,
        is_writable: false,
    });

    // Route PDAs for signer lookup (Routing/CC exact domain only).
    // Wildcard domain quotes use fee_data.wildcard_signers — no route PDAs needed.
    let domain_le = data.destination_domain.to_le_bytes();
    let is_wildcard = data.destination_domain == WILDCARD_DOMAIN;
    match &fee_account.fee_data {
        FeeData::Leaf(_) => {}
        FeeData::Routing(_) => {
            if !is_wildcard {
                let (route_key, _) = Pubkey::find_program_address(
                    route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: route_key,
                    is_signer: false,
                    is_writable: false,
                });
            }
        }
        FeeData::CrossCollateralRouting(_) => {
            if !is_wildcard {
                let (cc_specific_key, _) = Pubkey::find_program_address(
                    cc_route_pda_seeds!(fee_account_info.key, &domain_le, data.target_router),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: cc_specific_key,
                    is_signer: false,
                    is_writable: false,
                });
                let (cc_default_key, _) = Pubkey::find_program_address(
                    cc_route_pda_seeds!(fee_account_info.key, &domain_le, DEFAULT_ROUTER),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: cc_default_key,
                    is_signer: false,
                    is_writable: false,
                });
            }
        }
    }

    // Quote PDA (transient or standing).
    if let Some(scoped_salt) = data.scoped_salt {
        // Transient quote PDA.
        let (transient_key, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: transient_key,
            is_signer: false,
            is_writable: true,
        });
    } else {
        // Standing quote PDA.
        let standing_target_router = match &fee_account.fee_data {
            FeeData::CrossCollateralRouting(_) => data.target_router,
            _ => hyperlane_core::H256::zero(),
        };
        let (standing_key, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: standing_key,
            is_signer: false,
            is_writable: true,
        });
    }

    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(metas))
            .map_err(|_| ProgramError::BorshIoError)?,
    );

    Ok(())
}

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
fn process_set_remote_fee_route(
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

    if data.domain == 0 || data.domain == crate::accounts::WILDCARD_DOMAIN {
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
fn process_remove_remote_fee_route(
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

/// Fetches the fee account and verifies the owner is the signer.
///
/// Accounts consumed:
/// 0. `[writable]` Fee account (owned by this program).
/// 1. `[signer]` Owner.
fn fetch_fee_account_and_verify_owner<'a, 'b>(
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
