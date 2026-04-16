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
use account_utils::{create_pda_account, verify_account_uninitialized, SizedData};
use quote_verifier::SvmSignedQuote;

use crate::{
    accounts::{
        CcFeeQuoteContext, CrossCollateralRoute, CrossCollateralRouteAccount, FeeAccount,
        FeeAccountData, FeeData, FeeQuoteContext, FeeQuoteData, FeeStandingQuotePda,
        FeeStandingQuotePdaAccount, FeeStandingQuoteValue, QuoteContext, RouteDomain,
        RouteDomainAccount, TransientQuote, TransientQuoteAccount, DEFAULT_ROUTER,
    },
    cc_route_pda_seeds,
    error::Error,
    fee_account_pda_seeds,
    fee_math::FeeParams,
    fee_standing_quote_pda_seeds,
    instruction::{
        InitFee, Instruction, QuoteFee, RemoveCrossCollateralRoute, SetCrossCollateralRoute,
        SetRoute,
    },
    route_domain_pda_seeds, transient_quote_pda_seeds,
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
        Instruction::QuoteFee(data) => process_quote_fee(program_id, accounts, data),
        Instruction::SetRoute(data) => process_set_route(program_id, accounts, data),
        Instruction::RemoveRoute(domain) => process_remove_route(program_id, accounts, domain),
        Instruction::SetCrossCollateralRoute(data) => {
            process_set_cc_route(program_id, accounts, data)
        }
        Instruction::RemoveCrossCollateralRoute(data) => {
            process_remove_cc_route(program_id, accounts, data)
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
        Instruction::AddQuoteSigner { signer } => {
            process_add_quote_signer(program_id, accounts, signer)
        }
        Instruction::RemoveQuoteSigner { signer } => {
            process_remove_quote_signer(program_id, accounts, signer)
        }
        Instruction::SetMinIssuedAt { min_issued_at } => {
            process_set_min_issued_at(program_id, accounts, min_issued_at)
        }
        Instruction::SubmitQuote(quote) => process_submit_quote(program_id, accounts, quote),
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

/// Quote the fee for a transfer.
/// Cascade: transient quote → domain standing quote → wildcard standing quote → on-chain.
/// Returns fee amount as u64 LE via set_return_data.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[writable]` Payer (for transient quote autoclose).
/// 3. `[]` Transient quote PDA (optional — detected by TransientQuote discriminator).
///
/// If transient PDA is present:
///     4. `[]` Domain standing quote PDA (always present, may be uninitialized).
///     5. `[]` Wildcard standing quote PDA (always present, may be uninitialized).
///
/// If transient PDA is absent:
///     3. `[]` Domain standing quote PDA.
///     4. `[]` Wildcard standing quote PDA.
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

    // Account 0: System program.
    let _system_program_info = next_account_info(accounts_iter)?;
    if *_system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Fee account.
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    // Account 2: Payer (must be signer — receives lamports on transient autoclose).
    let _payer_info = next_account_info(accounts_iter)?;
    if !_payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 3: Either transient quote PDA or domain standing quote PDA.
    // Peek at discriminator to determine which.
    let next_info = next_account_info(accounts_iter)?;
    let has_transient = is_transient_quote(next_info, program_id)?;

    let (transient_info, domain_quotes_info, wildcard_quotes_info) = if has_transient {
        let domain_quotes_info = next_account_info(accounts_iter)?;
        let wildcard_quotes_info = next_account_info(accounts_iter)?;
        (Some(next_info), domain_quotes_info, wildcard_quotes_info)
    } else {
        let wildcard_quotes_info = next_account_info(accounts_iter)?;
        (None, next_info, wildcard_quotes_info)
    };

    // Validate ownership of standing quote PDAs.
    verify_optional_pda_owner(domain_quotes_info, program_id)?;
    verify_optional_pda_owner(wildcard_quotes_info, program_id)?;

    // --- Resolve on-chain curve type (always needed) ---

    let strategy = match &fee_account.fee_data {
        FeeData::Leaf(strategy) => {
            ensure_no_extraneous_accounts(accounts_iter)?;
            strategy.clone()
        }
        FeeData::Routing => {
            let strategy = resolve_routing(
                program_id,
                accounts_iter,
                fee_account_info.key,
                data.destination_domain,
            )?;
            ensure_no_extraneous_accounts(accounts_iter)?;
            strategy
        }
        FeeData::CrossCollateralRouting => {
            let strategy = resolve_cc_routing(
                program_id,
                accounts_iter,
                fee_account_info.key,
                data.destination_domain,
                &data.target_router,
            )?;
            ensure_no_extraneous_accounts(accounts_iter)?;
            strategy
        }
    };

    // --- Quote cascade: transient → standing → on-chain fallback ---

    // Step 1: Transient quote — override params, compute fee, autoclose.
    // Dispatch the correct context type based on fee data variant.
    if let Some(transient_acct) = transient_info {
        let fee = match &fee_account.fee_data {
            FeeData::CrossCollateralRouting => try_consume_transient_quote::<CcFeeQuoteContext>(
                program_id,
                transient_acct,
                _payer_info,
                fee_account_info.key,
                &strategy,
                &data,
            )?,
            _ => try_consume_transient_quote::<FeeQuoteContext>(
                program_id,
                transient_acct,
                _payer_info,
                fee_account_info.key,
                &strategy,
                &data,
            )?,
        };
        if let Some(fee) = fee {
            set_return_data(&fee.to_le_bytes());
            msg!("QuoteFee (transient): {} for amount {}", fee, data.amount);
            return Ok(());
        }
    }

    // Step 2: Domain standing quote.
    // TODO: check domain_quotes_info for matching recipient.

    // Step 3: Wildcard standing quote.
    // TODO: check wildcard_quotes_info for matching recipient.

    // Step 4: On-chain fallback — use resolved curve with on-chain params.
    let fee = strategy.compute_fee(data.amount)?;

    set_return_data(&fee.to_le_bytes());
    msg!("QuoteFee (on-chain): {} for amount {}", fee, data.amount);

    Ok(())
}

/// Checks if an account is a transient quote PDA by reading its discriminator.
/// Returns true if it has TransientQuote discriminator, false if it's a standing
/// quote or uninitialized. Errors if the account is owned by a different program.
fn is_transient_quote(
    account_info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<bool, ProgramError> {
    use crate::accounts::TRANSIENT_QUOTE_DISCRIMINATOR;

    // Uninitialized PDA: not a transient quote.
    if account_info.owner == &system_program::ID && account_info.data_is_empty() {
        return Ok(false);
    }

    if account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

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

/// Attempts to consume a transient quote PDA.
/// Generic over the context type (FeeQuoteContext or CcFeeQuoteContext).
/// Validates context match, payer binding, PDA derivation, and expiry.
/// On success: computes fee using on-chain curve + quoted params, autocloses PDA.
fn try_consume_transient_quote<C: crate::accounts::QuoteContext>(
    program_id: &Pubkey,
    transient_acct: &AccountInfo,
    payer_info: &AccountInfo,
    fee_account_key: &Pubkey,
    strategy: &crate::fee_math::FeeDataStrategy,
    quote_fee_data: &QuoteFee,
) -> Result<Option<u64>, ProgramError> {
    let transient = TransientQuoteAccount::fetch(&mut &transient_acct.data.borrow()[..])?
        .into_inner()
        .data;

    // Verify payer binding.
    if transient.payer != *payer_info.key {
        return Err(Error::TransientPayerMismatch.into());
    }

    // Re-derive PDA from stored scoped_salt and verify key matches.
    let (expected_key, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_account_key, transient.scoped_salt),
        program_id,
    );
    if *transient_acct.key != expected_key {
        return Err(Error::TransientPdaMismatch.into());
    }

    // Validate expiry against on-chain clock.
    let clock = Clock::get()?;
    if clock.unix_timestamp > transient.expiry {
        return Err(Error::QuoteExpired.into());
    }

    // Parse and validate context using the generic context type.
    let ctx = C::try_from_bytes(&transient.context).map_err(|_| Error::TransientContextMismatch)?;
    ctx.validate(quote_fee_data)?;

    // Parse quote data and compute fee using on-chain curve with quoted params.
    let quote_data = FeeQuoteData::try_from(transient.data.as_slice())
        .map_err(|_| Error::InvalidTransientData)?;

    let mut quoted_strategy = strategy.clone();
    *quoted_strategy.params_mut() = FeeParams {
        max_fee: quote_data.max_fee,
        half_amount: quote_data.half_amount,
    };
    let fee = quoted_strategy.compute_fee(quote_fee_data.amount)?;

    // Transient PDA must be writable for autoclose.
    if !transient_acct.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }

    // Autoclose: drain lamports to payer, zero data, reassign to system program.
    close_pda(transient_acct, payer_info)?;

    Ok(Some(fee))
}

/// Resolves the fee strategy for Routing mode by reading the RouteDomain PDA.
fn resolve_routing(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    fee_account_key: &Pubkey,
    destination_domain: u32,
) -> Result<crate::fee_math::FeeDataStrategy, ProgramError> {
    let route_pda_info = next_account_info(accounts_iter)?;

    let domain_le = destination_domain.to_le_bytes();
    let (expected_key, _) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_account_key, &domain_le),
        program_id,
    );
    if *route_pda_info.key != expected_key {
        return Err(ProgramError::InvalidSeeds);
    }
    if route_pda_info.owner != program_id {
        return Err(Error::RouteNotFound.into());
    }

    let route = RouteDomainAccount::fetch(&mut &route_pda_info.data.borrow()[..])?.into_inner();
    Ok(route.data.fee_data)
}

/// Resolves the fee strategy for CrossCollateralRouting mode.
/// Tries specific (destination, target_router) first, then falls back to
/// (destination, DEFAULT_ROUTER).
fn resolve_cc_routing(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    fee_account_key: &Pubkey,
    destination: u32,
    target_router: &hyperlane_core::H256,
) -> Result<crate::fee_math::FeeDataStrategy, ProgramError> {
    let dest_le = destination.to_le_bytes();

    // Specific CC route PDA (destination, target_router).
    let specific_pda_info = next_account_info(accounts_iter)?;
    let (expected_specific, _) = Pubkey::find_program_address(
        cc_route_pda_seeds!(fee_account_key, &dest_le, target_router),
        program_id,
    );
    if *specific_pda_info.key != expected_specific {
        return Err(ProgramError::InvalidSeeds);
    }

    if specific_pda_info.owner == program_id && !specific_pda_info.data_is_empty() {
        let route = CrossCollateralRouteAccount::fetch(&mut &specific_pda_info.data.borrow()[..])?
            .into_inner();
        return Ok(route.data.fee_data);
    }
    verify_optional_pda_owner(specific_pda_info, program_id)?;

    // Default CC route PDA (destination, DEFAULT_ROUTER).
    let default_pda_info = next_account_info(accounts_iter)?;
    let (expected_default, _) = Pubkey::find_program_address(
        cc_route_pda_seeds!(fee_account_key, &dest_le, DEFAULT_ROUTER),
        program_id,
    );
    if *default_pda_info.key != expected_default {
        return Err(ProgramError::InvalidSeeds);
    }

    if default_pda_info.owner == program_id && !default_pda_info.data_is_empty() {
        let route = CrossCollateralRouteAccount::fetch(&mut &default_pda_info.data.borrow()[..])?
            .into_inner();
        return Ok(route.data.fee_data);
    }
    verify_optional_pda_owner(default_pda_info, program_id)?;

    Err(Error::RouteNotFound.into())
}

/// Verifies an optional PDA account is either uninitialized (system-owned, empty)
/// or owned by this program. Errors if owned by a different program.
fn verify_optional_pda_owner(
    account_info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    if account_info.owner == &system_program::ID && account_info.data_is_empty() {
        return Ok(());
    }
    if account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
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

/// Add an authorized offchain quote signer (owner-only).
/// Reallocs the fee account if it grows.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account.
/// 2. `[signer, writable]` Owner.
fn process_add_quote_signer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    signer: H160,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    fee_account.signers.insert(signer);

    let owner_info = &accounts[2];
    FeeAccountData::new(fee_account.into()).store_with_rent_exempt_realloc(
        fee_account_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    msg!("Added quote signer: {}", signer);

    Ok(())
}

/// Remove an offchain quote signer (owner-only).
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writable]` Fee account.
/// 2. `[signer, writable]` Owner.
fn process_remove_quote_signer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    signer: H160,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    fee_account.signers.remove(&signer);

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Removed quote signer: {}", signer);

    Ok(())
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
    let (fee_account_info, mut fee_account) =
        fetch_fee_account_and_verify_owner(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    fee_account.min_issued_at = min_issued_at;

    FeeAccountData::new(fee_account.into()).store(fee_account_info, false)?;

    msg!("Set min_issued_at: {}", min_issued_at);

    Ok(())
}

/// Submit a signed offchain quote. Creates a transient or standing quote PDA.
/// For now, only transient quotes are implemented.
///
/// Transient quote accounts:
/// 0. `[executable]` System program.
/// 1. `[signer, writable]` Payer (bound to scoped_salt).
/// 2. `[]` Fee account.
/// 3. `[writable]` Transient quote PDA.
fn process_submit_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    quote: SvmSignedQuote,
) -> ProgramResult {
    let expiry_ts = quote.expiry_timestamp();
    let issued_at_ts = quote.issued_at_timestamp();

    // Validate expiry >= issued_at.
    if expiry_ts < issued_at_ts {
        return Err(Error::InvalidQuoteExpiry.into());
    }

    // Validate quote hasn't expired.
    let clock = Clock::get()?;
    if clock.unix_timestamp > expiry_ts {
        return Err(Error::QuoteExpired.into());
    }

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

    // Verify the quote signature against authorized signers.
    quote
        .verify_signer(
            fee_account_info.key,
            fee_account.domain_id,
            payer_info.key,
            &fee_account.signers,
        )
        .map_err(|_| Error::InvalidQuoteSignature)?;

    if quote.is_transient() {
        // Account 3: Transient quote PDA.
        let transient_pda_info = next_account_info(accounts_iter)?;

        let scoped_salt = quote.compute_scoped_salt(payer_info.key);
        let (expected_key, transient_bump) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        if *transient_pda_info.key != expected_key {
            return Err(ProgramError::InvalidSeeds);
        }
        verify_account_uninitialized(transient_pda_info)?;

        ensure_no_extraneous_accounts(accounts_iter)?;

        let transient = TransientQuoteAccount::new(
            TransientQuote {
                bump: transient_bump,
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

        // Parse context to get destination domain and recipient (BTreeMap key).
        // Standing quotes use the base context (44B) — recipient is the map key.
        // Amount must be wildcard (u64::MAX) for standing quotes.
        let ctx = FeeQuoteContext::try_from_bytes(&quote.context)
            .map_err(|_| Error::InvalidStandingQuoteContext)?;
        if ctx.amount != u64::MAX {
            return Err(Error::StandingQuoteAmountNotWildcard.into());
        }

        // Parse quote data.
        let quote_data = FeeQuoteData::try_from(quote.data.as_slice())
            .map_err(|_| Error::InvalidStandingQuoteData)?;

        // Account 3: Domain standing quote PDA.
        let domain_pda_info = next_account_info(accounts_iter)?;
        let domain_le = ctx.destination_domain.to_le_bytes();
        let (expected_domain_key, domain_bump) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le),
            program_id,
        );
        if *domain_pda_info.key != expected_domain_key {
            return Err(ProgramError::InvalidSeeds);
        }

        ensure_no_extraneous_accounts(accounts_iter)?;

        let is_new_pda =
            domain_pda_info.data_is_empty() && domain_pda_info.owner == &system_program::ID;

        let mut standing_pda = if is_new_pda {
            FeeStandingQuotePda {
                bump: domain_bump,
                quotes: std::collections::BTreeMap::new(),
            }
        } else {
            if domain_pda_info.owner != program_id {
                return Err(ProgramError::IncorrectProgramId);
            }
            FeeStandingQuotePdaAccount::fetch(&mut &domain_pda_info.data.borrow()[..])?
                .into_inner()
                .data
        };

        // Insert or update the quote for this recipient.
        let recipient_key = ctx.recipient;
        let new_value = FeeStandingQuoteValue {
            issued_at: issued_at_ts,
            expiry: expiry_ts,
            max_fee: quote_data.max_fee,
            half_amount: quote_data.half_amount,
        };

        if let Some(existing) = standing_pda.quotes.get(&recipient_key) {
            if issued_at_ts < existing.issued_at {
                return Err(Error::StaleStandingQuote.into());
            }
            // Equal issued_at → no-op (don't update, don't error).
            if issued_at_ts == existing.issued_at {
                msg!("Standing quote no-op (equal issued_at)");
                return Ok(());
            }
        }

        standing_pda.quotes.insert(recipient_key, new_value);

        let standing_account = FeeStandingQuotePdaAccount::new(standing_pda.into());

        if is_new_pda {
            let rent = Rent::get()?;
            create_pda_account(
                payer_info,
                &rent,
                SizedData::size(&standing_account),
                program_id,
                system_program_info,
                domain_pda_info,
                fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, domain_bump),
            )?;
            standing_account.store(domain_pda_info, false)?;

            // Update standing_quote_domains on fee account.
            let mut fee_account_mut = fee_account.data;
            fee_account_mut
                .standing_quote_domains
                .insert(ctx.destination_domain);
            FeeAccountData::new(fee_account_mut.into()).store_with_rent_exempt_realloc(
                fee_account_info,
                &Rent::get()?,
                payer_info,
                system_program_info,
            )?;
        } else {
            standing_account.store_with_rent_exempt_realloc(
                domain_pda_info,
                &Rent::get()?,
                payer_info,
                system_program_info,
            )?;
        }

        msg!(
            "Submitted standing quote for domain {} recipient {}",
            ctx.destination_domain,
            recipient_key
        );
    }

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

/// Set or update a cross-collateral route (owner-only).
/// Creates the CC route PDA if it doesn't exist, or updates it if it does.
/// Requires the fee account to be FeeData::CrossCollateralRouting.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[signer, writable]` Owner.
/// 3. `[writable]` CrossCollateralRoute PDA.
fn process_set_cc_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: SetCrossCollateralRoute,
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

    if !matches!(fee_account.fee_data, FeeData::CrossCollateralRouting) {
        return Err(Error::NotCrossCollateralRoutingFeeData.into());
    }

    // Account 3: CrossCollateralRoute PDA.
    let cc_route_pda_info = next_account_info(accounts_iter)?;
    let dest_le = data.destination.to_le_bytes();
    let (expected_cc_key, cc_bump) = Pubkey::find_program_address(
        cc_route_pda_seeds!(fee_account_info.key, &dest_le, data.target_router),
        program_id,
    );
    if *cc_route_pda_info.key != expected_cc_key {
        return Err(ProgramError::InvalidSeeds);
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    let cc_route = CrossCollateralRouteAccount::new(
        CrossCollateralRoute {
            bump: cc_bump,
            fee_data: data.fee_data,
        }
        .into(),
    );

    if cc_route_pda_info.data_is_empty() && cc_route_pda_info.owner == &system_program::ID {
        let owner_info = &accounts[2];
        let rent = Rent::get()?;
        create_pda_account(
            owner_info,
            &rent,
            SizedData::size(&cc_route),
            program_id,
            system_program_info,
            cc_route_pda_info,
            cc_route_pda_seeds!(fee_account_info.key, &dest_le, data.target_router, cc_bump),
        )?;
    } else if cc_route_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    cc_route.store(cc_route_pda_info, false)?;

    msg!(
        "Set CC route for destination {} target_router {}",
        data.destination,
        data.target_router
    );

    Ok(())
}

/// Remove a cross-collateral route, closing the CC route PDA (owner-only).
/// Returns rent to the owner. Requires FeeData::CrossCollateralRouting.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[]` Fee account.
/// 2. `[signer, writable]` Owner (receives rent refund).
/// 3. `[writable]` CrossCollateralRoute PDA.
fn process_remove_cc_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: RemoveCrossCollateralRoute,
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

    if !matches!(fee_account.fee_data, FeeData::CrossCollateralRouting) {
        return Err(Error::NotCrossCollateralRoutingFeeData.into());
    }

    // Account 3: CrossCollateralRoute PDA.
    let cc_route_pda_info = next_account_info(accounts_iter)?;
    let dest_le = data.destination.to_le_bytes();
    let (expected_cc_key, _) = Pubkey::find_program_address(
        cc_route_pda_seeds!(fee_account_info.key, &dest_le, data.target_router),
        program_id,
    );
    if *cc_route_pda_info.key != expected_cc_key {
        return Err(ProgramError::InvalidSeeds);
    }
    if cc_route_pda_info.owner != program_id {
        return Err(Error::RouteNotFound.into());
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    let owner_info = &accounts[2];
    close_pda(cc_route_pda_info, owner_info)?;

    msg!(
        "Removed CC route for destination {} target_router {}",
        data.destination,
        data.target_router
    );

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
