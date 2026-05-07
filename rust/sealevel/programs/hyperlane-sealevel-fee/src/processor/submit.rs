//! SubmitQuote, CloseTransientQuote, and PruneExpiredQuotes instruction handlers.

use std::collections::BTreeSet;

use account_utils::{
    create_pda_account, ensure_no_extraneous_accounts, verify_account_uninitialized,
    AccountInfoExt, AccountInitState, SizedData,
};
use hyperlane_core::H160;
use quote_verifier::{QuoteValidationError, SvmSignedQuote, ValidatableQuote};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
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
        CcFeeQuoteContext, CrossCollateralRouteAccount, FeeAccountData, FeeData, FeeQuoteContext,
        FeeStandingQuotePda, FeeStandingQuotePdaAccount, FeeStandingQuoteValue, QuoteContext,
        RouteDomainAccount, StandingQuoteAuthScope, TransientQuote, TransientQuoteAccount,
        DEFAULT_ROUTER, WILDCARD_AMOUNT, WILDCARD_DOMAIN, WILDCARD_RECIPIENT,
    },
    cc_route_pda_seeds,
    error::Error,
    fee_math::FeeDataStrategy,
    fee_standing_quote_pda_seeds, route_domain_pda_seeds, transient_quote_pda_seeds,
};

use super::common::{fetch_fee_account_and_verify_owner, verify_optional_pda_owner};

/// Submit a signed offchain quote. Creates a transient or standing quote PDA.
///
/// Transient accounts (expiry == issued_at):
/// `[0]` System program, `[1]` Payer (signer), `[2]` Fee account,
/// `[3..N]` Route PDAs, `[N+1]` Transient quote PDA (writable).
///
/// Standing accounts (expiry > issued_at):
/// `[0]` System program, `[1]` Payer (signer), `[2]` Fee account,
/// `[3..N]` Route PDAs, `[N+1]` Standing quote PDA (writable).
pub(super) fn process_submit_quote(
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
    // Returns (signers, standing auth scope).
    let (resolved_signers, resolved_auth_scope): (BTreeSet<H160>, StandingQuoteAuthScope) =
        match &fee_account.fee_data {
            FeeData::Leaf(cfg) => {
                let signers = cfg
                    .signers
                    .as_ref()
                    .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?
                    .clone();

                (signers, StandingQuoteAuthScope::Direct)
            }
            FeeData::Routing(_) => {
                let ctx = FeeQuoteContext::try_from_bytes(&quote.context)?;
                if ctx.destination_domain == WILDCARD_DOMAIN {
                    let signers = fee_account.fee_data.routing_wildcard_signers()?.clone();

                    (signers, StandingQuoteAuthScope::Direct)
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
                    (signers, StandingQuoteAuthScope::Direct)
                }
            }
            FeeData::CrossCollateralRouting(_) => {
                let ctx = CcFeeQuoteContext::try_from_bytes(&quote.context)?;
                if ctx.destination_domain == WILDCARD_DOMAIN {
                    let signers = fee_account.fee_data.cc_wildcard_signers()?.clone();

                    (signers, StandingQuoteAuthScope::Direct)
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

                        if specific_pda_info.owner == program_id
                            && !specific_pda_info.data_is_empty()
                        {
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

                            if default_pda_info.owner != program_id
                                || default_pda_info.data_is_empty()
                            {
                                return Err(Error::RouteNotFound.into());
                            }
                            (default_pda_info, StandingQuoteAuthScope::CcDefaultFallback)
                        }
                    };

                    let route = CrossCollateralRouteAccount::fetch(
                        &mut &resolved_pda_info.data.borrow()[..],
                    )?
                    .into_inner()
                    .data;
                    let signers = route
                        .signers
                        .ok_or(ProgramError::from(Error::OffchainQuotingNotConfigured))?;
                    (signers, auth_scope)
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

                if ctx.amount != WILDCARD_AMOUNT {
                    return Err(Error::StandingQuoteAmountNotWildcard.into());
                }

                if ctx.target_router == hyperlane_core::H256::zero()
                    || ctx.target_router == DEFAULT_ROUTER
                {
                    return Err(Error::ZeroTargetRouterNotAllowed.into());
                }

                (ctx.destination_domain, ctx.recipient, ctx.target_router)
            }
            _ => {
                let ctx = FeeQuoteContext::try_from_bytes(&quote.context)
                    .map_err(|_| Error::InvalidStandingQuoteContext)?;

                if ctx.amount != WILDCARD_AMOUNT {
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
        if destination_domain == WILDCARD_DOMAIN && recipient == WILDCARD_RECIPIENT {
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
pub(super) fn process_close_transient_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
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
pub(super) fn process_prune_expired_quotes(
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
