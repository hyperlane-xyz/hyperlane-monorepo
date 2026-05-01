//! Program state processor.

use borsh::BorshDeserialize;
use std::collections::HashMap;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

use access_control::AccessControl;
use account_utils::{
    create_pda_account, ensure_no_extraneous_accounts, verify_account_uninitialized,
    verify_rent_exempt, AccountData, AccountInfoExt, AccountInitState, DiscriminatorData,
    DiscriminatorPrefixed, SizedData,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

use quote_verifier::{QuoteValidationError, SvmSignedQuote, ValidatableQuote};

use crate::{
    accounts::{
        compute_gas_fee, GasPaymentAccount, GasPaymentData, Igp, IgpAccount, IgpFeeConfig,
        IgpQuoteContext, IgpQuoteData, IgpStandingQuote, IgpStandingQuoteAccount,
        IgpTransientQuote, IgpTransientQuoteAccount, OverheadIgp, OverheadIgpAccount, ProgramData,
        ProgramDataAccount, ResolvedQuote, WILDCARD_DOMAIN, WILDCARD_SENDER,
    },
    error::Error as IgpError,
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    igp_standing_quote_pda_seeds, igp_transient_quote_pda_seeds,
    instruction::{
        GasOracleConfig, GasOverheadConfig, GetIgpQuoteAccountMetas, InitIgp, InitOverheadIgp,
        Instruction as IgpInstruction, PayForGas, QuoteGasPayment, SetIgpQuoteSignerOperation,
    },
    overhead_igp_pda_seeds,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

/// Entrypoint for the IGP program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match IgpInstruction::try_from_slice(instruction_data)? {
        IgpInstruction::Init => {
            init(program_id, accounts)?;
        }
        IgpInstruction::InitIgp(data) => {
            init_igp(program_id, accounts, data)?;
        }
        IgpInstruction::InitOverheadIgp(data) => {
            init_overhead_igp(program_id, accounts, data)?;
        }
        IgpInstruction::PayForGas(payment) => {
            pay_for_gas(program_id, accounts, payment)?;
        }
        IgpInstruction::QuoteGasPayment(payment) => {
            quote_gas_payment(program_id, accounts, payment)?;
        }
        IgpInstruction::TransferIgpOwnership(new_owner) => {
            transfer_igp_variant_ownership::<Igp>(program_id, accounts, new_owner)?;
        }
        IgpInstruction::TransferOverheadIgpOwnership(new_owner) => {
            transfer_igp_variant_ownership::<OverheadIgp>(program_id, accounts, new_owner)?;
        }
        IgpInstruction::SetIgpBeneficiary(beneficiary) => {
            set_igp_beneficiary(program_id, accounts, beneficiary)?;
        }
        IgpInstruction::Claim => {
            claim(program_id, accounts)?;
        }
        IgpInstruction::SetDestinationGasOverheads(configs) => {
            set_destination_gas_overheads(program_id, accounts, configs)?;
        }
        IgpInstruction::SetGasOracleConfigs(configs) => {
            set_gas_oracle_configs(program_id, accounts, configs)?;
        }
        IgpInstruction::SetIgpQuoteConfig(config) => {
            set_igp_quote_config(program_id, accounts, config)?;
        }
        IgpInstruction::SetIgpQuoteSigner(operation) => {
            set_igp_quote_signer(program_id, accounts, operation)?;
        }
        IgpInstruction::SetIgpMinIssuedAt(min_issued_at) => {
            set_igp_min_issued_at(program_id, accounts, min_issued_at)?;
        }
        IgpInstruction::SubmitIgpQuote(quote) => {
            submit_igp_quote(program_id, accounts, quote)?;
        }
        IgpInstruction::CloseIgpTransientQuote => {
            close_igp_transient_quote(program_id, accounts)?;
        }
        IgpInstruction::CloseIgpStandingQuote => {
            close_igp_standing_quote(program_id, accounts)?;
        }
        IgpInstruction::GetIgpQuoteAccountMetas(data) => {
            get_igp_quote_account_metas(program_id, accounts, data)?;
        }
    }

    Ok(())
}

/// Initializes the program.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer account.
/// 2. `[writeable]` The program data PDA account.
fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The payer account.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: The program data account.
    let program_data_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(program_data_info)?;
    let (program_data_key, program_data_bump) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), program_id);
    if *program_data_info.key != program_data_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let program_data_account = ProgramDataAccount::new(
        ProgramData {
            bump_seed: program_data_bump,
            payment_count: 0,
        }
        .into(),
    );
    // Create the program data PDA account.
    let program_data_account_size = program_data_account.size();

    let rent = Rent::get()?;

    create_pda_account(
        payer_info,
        &rent,
        program_data_account_size,
        program_id,
        system_program_info,
        program_data_info,
        igp_program_data_pda_seeds!(program_data_bump),
    )?;

    // Store the program data.
    program_data_account.store(program_data_info, false)?;

    Ok(())
}

/// Initialize a new IGP account.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer account.
/// 2. `[writeable]` The IGP account to initialize.
fn init_igp(program_id: &Pubkey, accounts: &[AccountInfo], data: InitIgp) -> ProgramResult {
    let igp_key = init_igp_variant(
        program_id,
        accounts,
        |bump_seed| {
            Igp {
                bump_seed,
                salt: data.salt,
                owner: data.owner,
                beneficiary: data.beneficiary,
                gas_oracles: HashMap::new(),
                fee_config: None,
            }
            .into()
        },
        igp_pda_seeds!(data.salt),
    )?;

    msg!("Initialized IGP: {}", igp_key);

    Ok(())
}

/// Initialize a new overhead IGP account.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer account.
/// 2. `[writeable]` The Overhead IGP account to initialize.
fn init_overhead_igp(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: InitOverheadIgp,
) -> ProgramResult {
    let igp_key = init_igp_variant(
        program_id,
        accounts,
        |bump_seed| {
            OverheadIgp {
                bump_seed,
                salt: data.salt,
                owner: data.owner,
                inner: data.inner,
                gas_overheads: HashMap::new(),
            }
            .into()
        },
        overhead_igp_pda_seeds!(data.salt),
    )?;

    msg!("Initialized Overhead IGP: {}", igp_key);

    Ok(())
}

/// Initializes an IGP variant.
fn init_igp_variant<T: account_utils::DiscriminatorPrefixedData + SizedData>(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    get_data: impl FnOnce(u8) -> DiscriminatorPrefixed<T>,
    pda_seeds: &[&[u8]],
) -> Result<Pubkey, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The payer account and owner of the IGP account.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: The Overhead IGP account to initialize.
    let igp_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(igp_info)?;
    let (igp_key, igp_bump) = Pubkey::find_program_address(pda_seeds, program_id);
    if *igp_info.key != igp_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let igp_account = AccountData::<DiscriminatorPrefixed<T>>::new(get_data(igp_bump));

    let igp_account_size = igp_account.size();

    let rent = Rent::get()?;

    create_pda_account(
        payer_info,
        &rent,
        igp_account_size,
        program_id,
        system_program_info,
        igp_info,
        &[pda_seeds, &[&[igp_bump]]].concat(),
    )?;

    // Store the IGP account.
    igp_account.store(igp_info, false)?;

    Ok(*igp_info.key)
}

/// Dispatch authority PDA seeds for sender_authority verification.
/// Same seeds as mailbox uses: ["hyperlane_dispatcher", "-", "dispatch_authority"].
const DISPATCH_AUTHORITY_SEEDS: &[&[u8]] = &[b"hyperlane_dispatcher", b"-", b"dispatch_authority"];

/// Pay for gas.
///
/// Old flow accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer.
/// 2. `[writeable]` The IGP program data.
/// 3. `[signer]` Unique gas payment account.
/// 4. `[writeable]` Gas payment PDA.
/// 5. `[writeable]` The IGP account (owner == program_id).
/// 6. `[]` Overhead IGP account (optional, owner == program_id).
///
/// New flow (detected by account 6 owner != program_id):
///
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer.
/// 2. `[writeable]` The IGP program data.
/// 3. `[signer]` Unique gas payment account.
/// 4. `[writeable]` Gas payment PDA.
/// 5. `[writeable]` The IGP account (same position as old flow).
/// 6. `[signer]` sender_authority (dispatch_authority PDA — must be signer).
/// 7. `[]` quoted_sender (warp route program ID).
/// 8. Standing quote PDAs (exact, ws, wd — at least 1 required, trailing optional).
/// 9. `[]` Overhead IGP account (optional, after cascade).
fn pay_for_gas(program_id: &Pubkey, accounts: &[AccountInfo], payment: PayForGas) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The payer account.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: The IGP program data.
    let program_data_info = next_account_info(accounts_iter)?;
    let mut program_data =
        ProgramDataAccount::fetch(&mut &program_data_info.data.borrow()[..])?.into_inner();
    let expected_program_data_key = Pubkey::create_program_address(
        igp_program_data_pda_seeds!(program_data.bump_seed),
        program_id,
    )?;
    if program_data_info.key != &expected_program_data_key {
        return Err(ProgramError::InvalidSeeds);
    }
    if program_data_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 3: The unique gas payment account.
    // Uniqueness is enforced by making sure the message storage PDA based on
    // this unique message account is empty, which is done next.
    let unique_gas_payment_account_info = next_account_info(accounts_iter)?;
    if !unique_gas_payment_account_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 4: Gas payment PDA.
    let gas_payment_account_info = next_account_info(accounts_iter)?;
    let (gas_payment_key, gas_payment_bump) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(unique_gas_payment_account_info.key),
        program_id,
    );
    if gas_payment_account_info.key != &gas_payment_key {
        return Err(ProgramError::InvalidSeeds);
    }
    // Make sure an account can't be written to that already exists.
    verify_account_uninitialized(gas_payment_account_info)?;

    // Account 5: The IGP account.
    let igp_info = next_account_info(accounts_iter)?;
    // The caller should validate the IGP account before paying for gas,
    // but we do a basic sanity check.
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();
    let igp_key =
        Pubkey::create_program_address(igp_pda_seeds!(igp.salt, igp.bump_seed), program_id)?;
    if igp_info.key != &igp_key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Account 6: detection point — overhead IGP (old flow) or sender_authority (new flow).
    let (required_payment, gas_amount, transient_info_to_close) = match accounts_iter.next() {
        None => {
            let gas_amount = payment.gas_amount;
            let required_payment = igp.quote_gas_payment(payment.destination_domain, gas_amount)?;

            (required_payment, gas_amount, None)
        }
        Some(next) if next.owner == program_id => {
            // The caller is expected to only provide an overhead IGP they are comfortable
            // with / have configured themselves.
            let overhead_igp =
                OverheadIgpAccount::fetch(&mut &next.data.borrow()[..])?.into_inner();
            let overhead_igp_key = Pubkey::create_program_address(
                overhead_igp_pda_seeds!(overhead_igp.salt, overhead_igp.bump_seed),
                program_id,
            )?;
            if overhead_igp_key != *next.key || overhead_igp.inner != *igp_info.key {
                return Err(ProgramError::InvalidArgument);
            }

            let gas_amount = overhead_igp
                .gas_overhead(payment.destination_domain)
                .checked_add(payment.gas_amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let required_payment = igp.quote_gas_payment(payment.destination_domain, gas_amount)?;

            (required_payment, gas_amount, None)
        }
        Some(sender_authority_info) => {
            // sender_authority must be a signer (anti-spoofing).
            if !sender_authority_info.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }

            // Account 7: quoted_sender (warp route program ID).
            let quoted_sender_info = next_account_info(accounts_iter)?;
            let quoted_sender = quoted_sender_info.key;

            // Verify sender_authority is the dispatch authority PDA for quoted_sender.
            // This binds the authority to the actual message sender program.
            let (expected_authority, _) =
                Pubkey::find_program_address(DISPATCH_AUTHORITY_SEEDS, quoted_sender);
            if *sender_authority_info.key != expected_authority {
                return Err(ProgramError::InvalidSeeds);
            }

            // At least one quote PDA must follow.
            if accounts_iter.as_slice().is_empty() {
                return Err(ProgramError::NotEnoughAccountKeys);
            }

            let fee_token_mint = Pubkey::default();
            let clock = Clock::get()?;

            // Require fee_config for new flow — prevents stale quotes after config removal.
            let fee_config = igp.fee_config.as_ref().ok_or(IgpError::QuoteConfigNotSet)?;
            let min_issued_at = fee_config.min_issued_at;

            // Cascade: transient (if present) → standing (exact → ws → wd).
            // Peek discriminator to detect transient; if matched, all failures are hard errors.
            let is_transient = accounts_iter.as_slice().first().is_some_and(|first| {
                matches!(first.init_state(program_id), AccountInitState::Initialized)
                    && first.data.borrow().len() >= 9
                    && first.data.borrow()[1..9] == IgpTransientQuote::DISCRIMINATOR
            });

            let (resolved, overhead_info, transient_info_to_close) = if is_transient {
                let transient_info = next_account_info(accounts_iter)?;
                let quote = try_resolve_transient_quote(
                    program_id,
                    transient_info,
                    igp_info.key,
                    payer_info.key,
                    payment.destination_domain,
                    quoted_sender,
                    min_issued_at,
                    &clock,
                )?;

                (Some(quote), None, Some(transient_info))
            } else {
                // Standing cascade: exact → wildcard-sender → wildcard-domain.
                let cascade_levels: &[(u32, Pubkey)] = &[
                    (payment.destination_domain, *quoted_sender),
                    (payment.destination_domain, WILDCARD_SENDER),
                    (WILDCARD_DOMAIN, *quoted_sender),
                ];

                let resolved = try_standing_cascade(
                    program_id,
                    accounts_iter,
                    igp_info.key,
                    &fee_token_mint,
                    cascade_levels,
                    min_issued_at,
                    &clock,
                )?;

                (resolved, None, None)
            };

            // Overhead: from remaining accounts (non-matching accounts stay in iterator).
            let overhead_info = overhead_info.or_else(|| accounts_iter.next());

            let gas_amount = match overhead_info {
                Some(oi) => apply_overhead_gas(
                    oi,
                    program_id,
                    igp_info.key,
                    payment.destination_domain,
                    payment.gas_amount,
                )?,
                None => payment.gas_amount,
            };

            ensure_no_extraneous_accounts(accounts_iter)?;

            let required_payment = match resolved {
                Some(quote) => compute_gas_fee(
                    quote.token_exchange_rate,
                    quote.gas_price,
                    gas_amount,
                    quote.token_decimals,
                )?,
                None => igp.quote_gas_payment(payment.destination_domain, gas_amount)?,
            };

            (required_payment, gas_amount, transient_info_to_close)
        }
    };

    // Transfer the required payment to the IGP.
    invoke(
        &system_instruction::transfer(payer_info.key, igp_info.key, required_payment),
        &[payer_info.clone(), igp_info.clone()],
    )?;

    let gas_payment_account = GasPaymentAccount::new(
        GasPaymentData {
            sequence_number: program_data.payment_count,
            igp: *igp_info.key,
            destination_domain: payment.destination_domain,
            message_id: payment.message_id,
            gas_amount,
            payment: required_payment,
            unique_gas_payment_pubkey: *unique_gas_payment_account_info.key,
            slot: Clock::get()?.slot,
        }
        .into(),
    );
    let gas_payment_account_size = gas_payment_account.size();

    let rent = Rent::get()?;

    create_pda_account(
        payer_info,
        &rent,
        gas_payment_account_size,
        program_id,
        system_program_info,
        gas_payment_account_info,
        igp_gas_payment_pda_seeds!(unique_gas_payment_account_info.key, gas_payment_bump),
    )?;

    gas_payment_account.store(gas_payment_account_info, false)?;

    // Increment the payment count and update the program data.
    program_data.payment_count = program_data
        .payment_count
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    ProgramDataAccount::from(program_data).store(program_data_info, false)?;

    if let Some(transient_info) = transient_info_to_close {
        transient_info.close_account(payer_info)?;
    }

    msg!(
        "Paid IGP {} for {} gas for message {} to {}",
        igp_key,
        gas_amount,
        payment.message_id,
        payment.destination_domain
    );

    Ok(())
}

/// Quotes the required payment for a given gas amount and destination domain.
///
/// Old flow accounts:
/// 0. `[executable]` The system program.
/// 1. `[]` The IGP account (owner == program_id).
/// 2. `[]` The overhead IGP account (optional, owner == program_id).
///
/// New flow (detected by account 2 owner != program_id):
///
/// 0. `[executable]` The system program.
/// 1. `[]` The IGP account (same position as old flow).
/// 2. `[]` quoted_sender (owner != program_id — informational, NOT signer).
/// 3. Standing quote PDAs (exact, ws, wd — at least 1 required, trailing optional).
/// 4. `[]` The overhead IGP account (optional, after cascade).
fn quote_gas_payment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payment: QuoteGasPayment,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The IGP account (same position in both flows).
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    // Account 2: detection point.
    let required_payment = match accounts_iter.next() {
        None => igp.quote_gas_payment(payment.destination_domain, payment.gas_amount)?,
        Some(next) if next.owner == program_id => {
            let gas_amount = apply_overhead_gas(
                next,
                program_id,
                igp_info.key,
                payment.destination_domain,
                payment.gas_amount,
            )?;

            igp.quote_gas_payment(payment.destination_domain, gas_amount)?
        }
        Some(quoted_sender_info) => {
            let quoted_sender = quoted_sender_info.key;

            // At least one quote PDA must follow.
            if accounts_iter.as_slice().is_empty() {
                return Err(ProgramError::NotEnoughAccountKeys);
            }

            let fee_token_mint = Pubkey::default();
            let clock = Clock::get()?;

            // Require fee_config for new flow — prevents stale quotes after config removal.
            let fee_config = igp.fee_config.as_ref().ok_or(IgpError::QuoteConfigNotSet)?;
            let min_issued_at = fee_config.min_issued_at;

            // Standing cascade: exact → wildcard-sender → wildcard-domain.
            let cascade_levels: &[(u32, Pubkey)] = &[
                (payment.destination_domain, *quoted_sender),
                (payment.destination_domain, WILDCARD_SENDER),
                (WILDCARD_DOMAIN, *quoted_sender),
            ];

            let resolved = try_standing_cascade(
                program_id,
                accounts_iter,
                igp_info.key,
                &fee_token_mint,
                cascade_levels,
                min_issued_at,
                &clock,
            )?;

            // Overhead: from remaining accounts (non-matching accounts stay in iterator).
            let overhead_info = accounts_iter.next();

            let gas_amount = match overhead_info {
                Some(oi) => apply_overhead_gas(
                    oi,
                    program_id,
                    igp_info.key,
                    payment.destination_domain,
                    payment.gas_amount,
                )?,
                None => payment.gas_amount,
            };

            ensure_no_extraneous_accounts(accounts_iter)?;

            // Resolve: quote match → compute_gas_fee, else oracle fallback.
            match resolved {
                Some(quote) => compute_gas_fee(
                    quote.token_exchange_rate,
                    quote.gas_price,
                    gas_amount,
                    quote.token_decimals,
                )?,
                None => igp.quote_gas_payment(payment.destination_domain, gas_amount)?,
            }
        }
    };

    set_return_data(&borsh::to_vec(&SimulationReturnData::new(
        required_payment,
    ))?);

    Ok(())
}

/// Verifies an overhead IGP account and returns the gas amount with overhead applied.
fn apply_overhead_gas(
    overhead_igp_info: &AccountInfo,
    program_id: &Pubkey,
    igp_key: &Pubkey,
    destination_domain: u32,
    gas_amount: u64,
) -> Result<u64, ProgramError> {
    if overhead_igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let overhead_igp =
        OverheadIgpAccount::fetch(&mut &overhead_igp_info.data.borrow()[..])?.into_inner();
    let overhead_igp_key = Pubkey::create_program_address(
        overhead_igp_pda_seeds!(overhead_igp.salt, overhead_igp.bump_seed),
        program_id,
    )?;
    if overhead_igp_key != *overhead_igp_info.key || overhead_igp.inner != *igp_key {
        return Err(ProgramError::InvalidArgument);
    }

    overhead_igp
        .gas_overhead(destination_domain)
        .checked_add(gas_amount)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Sets the beneficiary of an IGP.
///
/// Accounts:
/// 0. `[]` The IGP.
/// 1. `[signer]` The owner of the IGP account.
fn set_igp_beneficiary(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    beneficiary: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let (igp_info, mut igp, _) =
        get_igp_variant_and_verify_owner::<Igp>(program_id, accounts_iter)?;

    // Update the beneficiary and store it.
    igp.beneficiary = beneficiary;
    IgpAccount::new(igp.into()).store(igp_info, false)?;

    Ok(())
}

/// Transfers ownership of an IGP variant.
///
/// Accounts:
/// 0. `[writeable]` The IGP or OverheadIGP.
/// 1. `[signer]` The owner of the IGP account.
fn transfer_igp_variant_ownership<T: account_utils::DiscriminatorPrefixedData + AccessControl>(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> Result<(), ProgramError> {
    let accounts_iter = &mut accounts.iter();

    let (igp_info, mut igp, _) = get_igp_variant_and_verify_owner::<T>(program_id, accounts_iter)?;

    // Update the owner and store it.
    igp.set_owner(new_owner)?;
    AccountData::<DiscriminatorPrefixed<T>>::new(igp.into()).store(igp_info, false)?;

    Ok(())
}

/// Gets an IGP variant and verifies the owner.
///
/// Accounts:
/// 0. `[]` The IGP variant.
/// 1. `[signer]` The owner of the IGP variant.
fn get_igp_variant_and_verify_owner<
    'a,
    'b,
    T: account_utils::DiscriminatorPrefixedData + AccessControl,
>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<(&'a AccountInfo<'b>, T, &'a AccountInfo<'b>), ProgramError> {
    // Account 0: The IGP or OverheadIGP account.
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let igp = AccountData::<DiscriminatorPrefixed<T>>::fetch(&mut &igp_info.data.borrow()[..])?
        .into_inner();

    // Account 1: The owner of the IGP account.
    let owner_info = next_account_info(accounts_iter)?;
    // Errors if `owner_info` is not a signer or is not the current owner.
    igp.ensure_owner_signer(owner_info)?;

    Ok((igp_info, igp.data, owner_info))
}

/// Sends funds accrued in an IGP to its beneficiary.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The IGP.
/// 2. `[writeable]` The IGP beneficiary.
fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The IGP.
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();
    let expected_igp_key =
        Pubkey::create_program_address(igp_pda_seeds!(igp.salt, igp.bump_seed), program_id)?;
    if igp_info.key != &expected_igp_key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Account 2: The IGP beneficiary.
    let igp_beneficiary = next_account_info(accounts_iter)?;
    if igp_beneficiary.key != &igp.beneficiary {
        return Err(ProgramError::InvalidArgument);
    }

    let rent = Rent::get()?;

    let required_balance = rent.minimum_balance(igp_info.data_len());

    let transfer_amount = igp_info.lamports().saturating_sub(required_balance);
    **igp_info.try_borrow_mut_lamports()? -= transfer_amount;
    **igp_beneficiary.try_borrow_mut_lamports()? += transfer_amount;

    // For good measure...
    verify_rent_exempt(igp_info, &rent)?;

    Ok(())
}

/// Sets destination gas overheads for an OverheadIGP.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The OverheadIGP.
/// 2. `[signer]` The OverheadIGP owner.
fn set_destination_gas_overheads(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasOverheadConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Errors if `owner_info` is not a signer or is not the current owner.
    let (overhead_igp_info, mut overhead_igp, owner_info) =
        get_igp_variant_and_verify_owner::<OverheadIgp>(program_id, accounts_iter)?;

    configs.into_iter().for_each(|config| {
        match config.gas_overhead {
            Some(gas_overhead) => overhead_igp
                .gas_overheads
                .insert(config.destination_domain, gas_overhead),
            None => overhead_igp
                .gas_overheads
                .remove(&config.destination_domain),
        };
    });

    let overhead_igp_account = OverheadIgpAccount::new(overhead_igp.into());

    overhead_igp_account.store_with_rent_exempt_realloc(
        overhead_igp_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}

/// Sets gas oracle configs for an IGP.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The IGP.
/// 2. `[signer]` The IGP owner.
fn set_gas_oracle_configs(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasOracleConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    // Required to invoke `system_instruction::transfer` in `store_with_rent_exempt_realloc`.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Errors if `owner_info` is not a signer or is not the current owner.
    let (igp_info, mut igp, owner_info) =
        get_igp_variant_and_verify_owner::<Igp>(program_id, accounts_iter)?;

    configs.into_iter().for_each(|config| {
        match config.gas_oracle {
            Some(gas_oracle) => igp.gas_oracles.insert(config.domain, gas_oracle),
            None => igp.gas_oracles.remove(&config.domain),
        };
    });

    let igp_account = IgpAccount::new(igp.into());

    igp_account.store_with_rent_exempt_realloc(
        igp_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}

/// Sets or removes the IGP quote configuration.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The IGP account.
/// 2. `[signer]` The IGP owner.
fn set_igp_quote_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: Option<IgpFeeConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: IGP + Account 2: Owner (signer).
    // Discriminator check rejects OverheadIgp.
    let (igp_info, mut igp, owner_info) =
        get_igp_variant_and_verify_owner::<Igp>(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    igp.fee_config = config;

    let igp_account = IgpAccount::new(igp.into());
    igp_account.store_with_rent_exempt_realloc(
        igp_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}

/// Adds or removes an authorized quote signer on the IGP.
/// Requires fee_config to be set via SetIgpQuoteConfig first.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The IGP account.
/// 2. `[signer]` The IGP owner.
fn set_igp_quote_signer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    operation: SetIgpQuoteSignerOperation,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: IGP + Account 2: Owner (signer).
    let (igp_info, mut igp, owner_info) =
        get_igp_variant_and_verify_owner::<Igp>(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    let fee_config = igp
        .fee_config
        .as_mut()
        .ok_or(ProgramError::InvalidArgument)?;

    match operation {
        SetIgpQuoteSignerOperation::Add(signer) => {
            fee_config.signers.insert(signer);
        }
        SetIgpQuoteSignerOperation::Remove(signer) => {
            if !fee_config.signers.remove(&signer) {
                return Err(ProgramError::InvalidArgument);
            }
        }
    }

    let igp_account = IgpAccount::new(igp.into());
    igp_account.store_with_rent_exempt_realloc(
        igp_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}

/// Sets the min_issued_at threshold on the IGP.
/// Monotonic: new value must be >= current value.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The IGP account.
/// 2. `[signer]` The IGP owner.
fn set_igp_min_issued_at(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    min_issued_at: i64,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: IGP + Account 2: Owner (signer).
    let (igp_info, mut igp, owner_info) =
        get_igp_variant_and_verify_owner::<Igp>(program_id, accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    let fee_config = igp
        .fee_config
        .as_mut()
        .ok_or(ProgramError::InvalidArgument)?;

    // Monotonic: cannot decrease.
    if min_issued_at < fee_config.min_issued_at {
        return Err(ProgramError::InvalidArgument);
    }

    fee_config.min_issued_at = min_issued_at;

    let igp_account = IgpAccount::new(igp.into());
    igp_account.store_with_rent_exempt_realloc(
        igp_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}

/// Submits an offchain-signed quote to the IGP.
/// Standing path: creates or updates a standing quote PDA.
/// Transient path: creates a transient quote PDA for single-transaction use.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer, writeable]` The payer.
/// 2. `[]` The IGP account.
/// 3. `[writeable]` The standing quote PDA.
fn submit_igp_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    quote: SvmSignedQuote,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Payer (signer, writable).
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: IGP account (read-only).
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    // Sanity check: verify IGP PDA derivation (same check as pay_for_gas).
    let igp_key =
        Pubkey::create_program_address(igp_pda_seeds!(igp.salt, igp.bump_seed), program_id)?;
    if igp_info.key != &igp_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let fee_config = igp.fee_config.as_ref().ok_or(IgpError::QuoteConfigNotSet)?;

    // Account 3: Quote PDA (writable).
    let quote_pda_info = next_account_info(accounts_iter)?;

    // --- Parse quote fields ---
    let ctx = IgpQuoteContext::try_from(quote.context.as_slice())?;
    let data = IgpQuoteData::try_from(quote.data.as_slice())?;

    if ctx.fee_token_mint != Pubkey::default() {
        return Err(IgpError::NonDefaultFeeTokenMint.into());
    }

    // --- Verify signature ---
    quote
        .verify_signer(
            igp_info.key,
            fee_config.domain_id,
            payer_info.key,
            &fee_config.signers,
        )
        .map_err(Into::<ProgramError>::into)?;

    // --- Validate timestamps ---
    let clock = Clock::get()?;
    quote
        .validate_quote_submission(fee_config.min_issued_at, &clock)
        .map_err(Into::<ProgramError>::into)?;

    let issued_at_ts = quote.issued_at_timestamp();
    let expiry_ts = quote.expiry_timestamp();

    // --- Business logic ---

    // Reject fully-wildcarded.
    if ctx.destination_domain == WILDCARD_DOMAIN && ctx.sender == WILDCARD_SENDER {
        return Err(QuoteValidationError::FullyWildcardedQuote.into());
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    if quote.is_transient() {
        // --- Transient path ---
        let scoped_salt = quote.compute_scoped_salt(payer_info.key);
        let (expected_pda, pda_bump) = Pubkey::find_program_address(
            igp_transient_quote_pda_seeds!(igp_info.key, scoped_salt),
            program_id,
        );
        if *quote_pda_info.key != expected_pda {
            return Err(ProgramError::InvalidSeeds);
        }

        // Transient PDAs must not already exist.
        match quote_pda_info.init_state(program_id) {
            AccountInitState::Uninitialized => {
                let transient_quote = IgpTransientQuote {
                    bump_seed: pda_bump,
                    payer: *payer_info.key,
                    scoped_salt,
                    destination_domain: ctx.destination_domain,
                    sender: ctx.sender,
                    token_exchange_rate: data.token_exchange_rate,
                    gas_price: data.gas_price,
                    token_decimals: data.token_decimals,
                    expiry: expiry_ts,
                };

                let transient_account = IgpTransientQuoteAccount::new(transient_quote.into());
                let rent = Rent::get()?;

                create_pda_account(
                    payer_info,
                    &rent,
                    transient_account.size(),
                    program_id,
                    system_program_info,
                    quote_pda_info,
                    igp_transient_quote_pda_seeds!(igp_info.key, scoped_salt, pda_bump),
                )?;

                transient_account.store(quote_pda_info, false)?;
            }
            AccountInitState::Initialized => {
                return Err(ProgramError::AccountAlreadyInitialized);
            }
            AccountInitState::OwnerMismatch => {
                return Err(ProgramError::IncorrectProgramId);
            }
        }
    } else {
        // --- Standing path ---
        let dest_domain_le = ctx.destination_domain.to_le_bytes();
        let (expected_pda, pda_bump) = Pubkey::find_program_address(
            igp_standing_quote_pda_seeds!(
                igp_info.key,
                ctx.fee_token_mint,
                &dest_domain_le,
                ctx.sender
            ),
            program_id,
        );
        if *quote_pda_info.key != expected_pda {
            return Err(ProgramError::InvalidSeeds);
        }

        let standing_quote = IgpStandingQuote {
            bump_seed: pda_bump,
            fee_token_mint: ctx.fee_token_mint,
            destination_domain: ctx.destination_domain,
            sender: ctx.sender,
            token_exchange_rate: data.token_exchange_rate,
            gas_price: data.gas_price,
            token_decimals: data.token_decimals,
            issued_at: issued_at_ts,
            expiry: expiry_ts,
        };

        let standing_account = IgpStandingQuoteAccount::new(standing_quote.into());

        match quote_pda_info.init_state(program_id) {
            AccountInitState::Uninitialized => {
                let rent = Rent::get()?;
                create_pda_account(
                    payer_info,
                    &rent,
                    standing_account.size(),
                    program_id,
                    system_program_info,
                    quote_pda_info,
                    igp_standing_quote_pda_seeds!(
                        igp_info.key,
                        ctx.fee_token_mint,
                        &dest_domain_le,
                        ctx.sender,
                        pda_bump
                    ),
                )?;

                standing_account.store(quote_pda_info, false)?;
            }
            AccountInitState::Initialized => {
                let existing =
                    IgpStandingQuoteAccount::fetch(&mut &quote_pda_info.data.borrow()[..])?
                        .into_inner();

                if issued_at_ts < existing.data.issued_at {
                    return Err(QuoteValidationError::StaleStandingQuoteUpdate.into());
                }
                // Equal issued_at → no-op, matching EVM and fee program behavior.
                if issued_at_ts == existing.data.issued_at {
                    msg!("IGP standing quote no-op (equal issued_at)");
                    return Ok(());
                }

                standing_account.store(quote_pda_info, false)?;
            }
            AccountInitState::OwnerMismatch => {
                return Err(ProgramError::IncorrectProgramId);
            }
        }
    }

    Ok(())
}

// --- Quote cascade resolution helpers ---

/// Walks standing quote PDAs in strict order. At least the first expected PDA
/// must be present; after one expected PDA is consumed, remaining trailing PDAs
/// may be omitted and the next account is left for overhead handling.
#[allow(clippy::too_many_arguments)]
fn try_standing_cascade(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    igp_key: &Pubkey,
    fee_token_mint: &Pubkey,
    cascade_levels: &[(u32, Pubkey)],
    min_issued_at: i64,
    clock: &Clock,
) -> Result<Option<ResolvedQuote>, ProgramError> {
    let mut consumed_quote_pda = false;

    for (dest_domain, sender) in cascade_levels {
        let account = match accounts_iter.as_slice().first() {
            None => break,
            Some(a) => a,
        };

        let dest_le = dest_domain.to_le_bytes();
        let (expected_standing, _) = Pubkey::find_program_address(
            igp_standing_quote_pda_seeds!(igp_key, fee_token_mint, &dest_le, sender),
            program_id,
        );

        if *account.key != expected_standing {
            if !consumed_quote_pda {
                return Err(ProgramError::NotEnoughAccountKeys);
            }
            break;
        }

        let account = next_account_info(accounts_iter)?;
        consumed_quote_pda = true;

        match account.init_state(program_id) {
            AccountInitState::Uninitialized => {}
            AccountInitState::OwnerMismatch => return Err(ProgramError::IncorrectProgramId),
            AccountInitState::Initialized => {
                let standing =
                    IgpStandingQuoteAccount::fetch(&mut &account.data.borrow()[..])?.into_inner();

                if standing.data.validate_quote(min_issued_at, clock).is_ok() {
                    return Ok(Some(ResolvedQuote {
                        token_exchange_rate: standing.data.token_exchange_rate,
                        gas_price: standing.data.gas_price,
                        token_decimals: standing.data.token_decimals,
                    }));
                }
            }
        }
    }

    if !consumed_quote_pda {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    Ok(None)
}

#[allow(unused, clippy::too_many_arguments)]
/// Resolves a transient quote PDA. Called only after discriminator check confirms
/// the account is a transient PDA — all validation failures are hard errors.
/// Returns the resolved quote values on success.
fn try_resolve_transient_quote(
    program_id: &Pubkey,
    account_info: &AccountInfo,
    igp_key: &Pubkey,
    payer: &Pubkey,
    dest_domain: u32,
    sender: &Pubkey,
    min_issued_at: i64,
    clock: &Clock,
) -> Result<ResolvedQuote, ProgramError> {
    let transient =
        IgpTransientQuoteAccount::fetch(&mut &account_info.data.borrow()[..])?.into_inner();

    // Re-derive PDA from stored scoped_salt to verify account authenticity.
    let (expected, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(igp_key, transient.data.scoped_salt),
        program_id,
    );
    if *account_info.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify payer binding — prevents another payer from using this quote.
    if transient.data.payer != *payer {
        return Err(QuoteValidationError::TransientPayerMismatch.into());
    }

    // Verify stored context matches expected values.
    if transient.data.destination_domain != dest_domain || transient.data.sender != *sender {
        return Err(QuoteValidationError::TransientContextMismatch.into());
    }

    // Expired or stale → hard error (discriminator matched, so this IS the transient).
    transient
        .data
        .validate_quote(min_issued_at, clock)
        .map_err(Into::<ProgramError>::into)?;

    Ok(ResolvedQuote {
        token_exchange_rate: transient.data.token_exchange_rate,
        gas_price: transient.data.gas_price,
        token_decimals: transient.data.token_decimals,
    })
}

/// Closes an orphaned transient quote PDA, refunding rent to the stored payer.
///
/// Accounts:
/// 0. `[writeable]` The transient quote PDA.
/// 1. `[signer, writeable]` The payer (must match stored payer).
/// 2. `[]` The IGP account (for PDA re-derivation).
fn close_igp_transient_quote(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Transient quote PDA.
    let transient_pda_info = next_account_info(accounts_iter)?;
    if transient_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let transient =
        IgpTransientQuoteAccount::fetch(&mut &transient_pda_info.data.borrow()[..])?.into_inner();

    // Account 1: Payer (signer).
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: IGP account (read-only, for PDA re-derivation).
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    ensure_no_extraneous_accounts(accounts_iter)?;

    // Verify stored payer matches signer.
    if transient.data.payer != *payer_info.key {
        return Err(QuoteValidationError::TransientPayerMismatch.into());
    }

    // Re-derive PDA from IGP key + stored scoped_salt to verify account authenticity.
    let (expected, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(igp_info.key, transient.data.scoped_salt),
        program_id,
    );
    if *transient_pda_info.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }

    transient_pda_info.close_account(payer_info)?;

    Ok(())
}

/// Closes an expired standing quote PDA, refunding rent to the IGP's beneficiary.
///
/// Accounts:
/// 0. `[writeable]` The standing quote PDA.
/// 1. `[]` The IGP account (for PDA re-derivation + beneficiary check).
/// 2. `[writeable]` The beneficiary (receives rent refund).
fn close_igp_standing_quote(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Standing quote PDA.
    let standing_pda_info = next_account_info(accounts_iter)?;
    if standing_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let standing =
        IgpStandingQuoteAccount::fetch(&mut &standing_pda_info.data.borrow()[..])?.into_inner();

    // Account 1: IGP account (read-only).
    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    // Account 2: Beneficiary (writable, receives rent refund).
    let beneficiary_info = next_account_info(accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    // Verify beneficiary matches IGP's beneficiary.
    if *beneficiary_info.key != igp.beneficiary {
        return Err(IgpError::BeneficiaryMismatch.into());
    }

    // Re-derive PDA from stored context fields + IGP key.
    let dest_domain_le = standing.data.destination_domain.to_le_bytes();
    let (expected, _) = Pubkey::find_program_address(
        igp_standing_quote_pda_seeds!(
            igp_info.key,
            standing.data.fee_token_mint,
            &dest_domain_le,
            standing.data.sender
        ),
        program_id,
    );
    if *standing_pda_info.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify quote has expired.
    let clock = Clock::get()?;
    if clock.unix_timestamp <= standing.data.expiry {
        return Err(IgpError::StandingQuoteNotExpired.into());
    }

    standing_pda_info.close_account(beneficiary_info)?;

    Ok(())
}

/// Simulation-only: returns the required account metas for PayForGas new flow.
/// If scoped_salt is provided, returns prefix + transient PDA only (transient
/// and standing are mutually exclusive paths). Otherwise, walks the standing
/// cascade and returns prefix + trimmed standing PDAs.
///
/// Accounts:
/// 0. `[]` The IGP account.
/// 1. `[]` Exact standing PDA (ignored if scoped_salt provided).
/// 2. `[]` Wildcard-sender standing PDA (ignored if scoped_salt provided).
/// 3. `[]` Wildcard-domain standing PDA (ignored if scoped_salt provided).
fn get_igp_quote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: GetIgpQuoteAccountMetas,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let igp_info = next_account_info(accounts_iter)?;
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    let exact_info = next_account_info(accounts_iter)?;
    let ws_info = next_account_info(accounts_iter)?;
    let wd_info = next_account_info(accounts_iter)?;

    ensure_no_extraneous_accounts(accounts_iter)?;

    // Build fixed prefix (PayForGas accounts 0-7).
    let (program_data_key, _) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), program_id);
    let (sender_authority, _) =
        Pubkey::find_program_address(DISPATCH_AUTHORITY_SEEDS, &data.sender);

    // Placeholders: SDK must replace payer (idx 1), unique_gas_payment (idx 3),
    // and gas_payment_pda (idx 4, derived from unique_gas_payment) before use.
    let mut metas = vec![
        SerializableAccountMeta {
            pubkey: system_program::ID,
            is_signer: false,
            is_writable: false,
        },
        SerializableAccountMeta {
            // Placeholder: payer (SDK replaces with actual payer).
            pubkey: Pubkey::default(),
            is_signer: true,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: program_data_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            // Placeholder: unique_gas_payment keypair (SDK generates fresh).
            pubkey: Pubkey::default(),
            is_signer: true,
            is_writable: false,
        },
        SerializableAccountMeta {
            // Placeholder: gas_payment_pda (SDK derives from unique_gas_payment).
            pubkey: Pubkey::default(),
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: *igp_info.key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: sender_authority,
            is_signer: true,
            is_writable: false,
        },
        SerializableAccountMeta {
            pubkey: data.sender,
            is_signer: false,
            is_writable: false,
        },
    ];

    // Require fee_config for both paths — prevents returning metas after config removal.
    let fee_config = igp.fee_config.as_ref().ok_or(IgpError::QuoteConfigNotSet)?;

    if let Some(scoped_salt) = data.scoped_salt {
        // Transient path: prefix + transient PDA only (no standing PDAs).
        let (transient_key, _) = Pubkey::find_program_address(
            igp_transient_quote_pda_seeds!(igp_info.key, scoped_salt),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: transient_key,
            is_signer: false,
            is_writable: true,
        });
    } else {
        // Standing path: walk cascade, trim at first valid.
        let fee_token_mint = Pubkey::default();
        let clock = Clock::get()?;
        let min_issued_at = fee_config.min_issued_at;

        let cascade: [(&AccountInfo, u32, &Pubkey); 3] = [
            (exact_info, data.destination_domain, &data.sender),
            (ws_info, data.destination_domain, &WILDCARD_SENDER),
            (wd_info, WILDCARD_DOMAIN, &data.sender),
        ];

        let (needed_pdas, _) = cascade.iter().try_fold(
            (Vec::<SerializableAccountMeta>::new(), false),
            |(mut pdas, resolved), (account, domain, sender)| {
                if resolved {
                    return Ok((pdas, true));
                }

                let dest_le = domain.to_le_bytes();
                let (expected, _) = Pubkey::find_program_address(
                    igp_standing_quote_pda_seeds!(igp_info.key, fee_token_mint, &dest_le, sender),
                    program_id,
                );
                if *account.key != expected {
                    return Err(ProgramError::InvalidSeeds);
                }

                let is_valid = match account.init_state(program_id) {
                    AccountInitState::Uninitialized => false,
                    AccountInitState::Initialized => {
                        let quote =
                            IgpStandingQuoteAccount::fetch(&mut &account.data.borrow()[..])?;
                        quote
                            .into_inner()
                            .data
                            .validate_quote(min_issued_at, &clock)
                            .is_ok()
                    }
                    AccountInitState::OwnerMismatch => return Err(ProgramError::InvalidArgument),
                };

                pdas.push(SerializableAccountMeta {
                    pubkey: *account.key,
                    is_signer: false,
                    is_writable: false,
                });

                Ok((pdas, is_valid))
            },
        )?;

        metas.extend(needed_pdas);
    }

    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(metas))
            .map_err(|_| ProgramError::BorshIoError)?,
    );

    Ok(())
}
