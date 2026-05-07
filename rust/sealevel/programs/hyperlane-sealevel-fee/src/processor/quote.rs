//! QuoteFee instruction handler.

use account_utils::{ensure_no_extraneous_accounts, AccountInfoExt, AccountInitState};
use quote_verifier::{QuoteValidationError, ValidatableQuote};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

use crate::{
    accounts::{
        CcFeeQuoteContext, CrossCollateralRouteAccount, FeeAccountData, FeeData, FeeQuoteContext,
        FeeStandingQuotePdaAccount, QuoteContext, RouteDomainAccount, StandingQuoteAuthScope,
        TransientQuoteAccount, DEFAULT_ROUTER, TRANSIENT_QUOTE_DISCRIMINATOR, WILDCARD_DOMAIN,
        WILDCARD_RECIPIENT,
    },
    cc_route_pda_seeds,
    error::Error,
    fee_math::FeeDataStrategy,
    fee_standing_quote_pda_seeds,
    instruction::QuoteFee,
    route_domain_pda_seeds, transient_quote_pda_seeds,
};

use super::common::verify_optional_pda_owner;

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
pub(super) fn process_quote_fee(
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

        set_return_data(&fee.to_le_bytes());
        msg!("QuoteFee (transient): {} for amount {}", fee, data.amount);
        return Ok(());
    }

    // Steps 2-3: Domain standing quote → wildcard domain standing quote.
    for (pda_info, domain) in [
        (domain_quotes_info, data.destination_domain),
        (wildcard_quotes_info, WILDCARD_DOMAIN),
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

/// Consumes a transient quote PDA.
/// Generic over the context type (FeeQuoteContext or CcFeeQuoteContext).
/// Validates context match, payer binding, PDA derivation, and expiry.
/// On success: computes fee using on-chain curve + quoted params, autocloses PDA.
/// Any soft mismatch (payer/context/variant/expiry) returns Err — passing a
/// transient slot is a caller commitment to use it.
#[allow(clippy::too_many_arguments)]
fn try_consume_transient_quote<C: QuoteContext>(
    program_id: &Pubkey,
    transient_acct: &AccountInfo,
    payer_info: &AccountInfo,
    fee_account_key: &Pubkey,
    strategy: &FeeDataStrategy,
    quote_fee_data: &QuoteFee,
    min_issued_at: i64,
    clock: &Clock,
) -> Result<u64, ProgramError> {
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

    Ok(fee)
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
    strategy: &FeeDataStrategy,
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
) -> Result<Option<FeeDataStrategy>, ProgramError> {
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
) -> Result<(FeeDataStrategy, bool), ProgramError> {
    let dest_le = destination.to_le_bytes();

    let mut chosen: Option<(FeeDataStrategy, bool)> = None;
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
