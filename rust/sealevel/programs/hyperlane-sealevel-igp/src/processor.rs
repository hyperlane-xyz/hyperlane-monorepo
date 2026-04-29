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
    verify_rent_exempt, AccountData, AccountInfoExt, AccountInitState, DiscriminatorPrefixed,
    SizedData,
};
use serializable_account_meta::SimulationReturnData;

use quote_verifier::{
    QuoteValidationError, SvmSignedQuote, ValidatableQuote, MAX_QUOTE_ISSUED_AT_FUTURE_SKEW_SECS,
};

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
        GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp,
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

/// Pay for gas.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[signer]` The payer.
/// 2. `[writeable]` The IGP program data.
/// 3. `[signer]` Unique gas payment account.
/// 4. `[writeable]` Gas payment PDA.
/// 5. `[writeable]` The IGP account.
/// 6. `[]` Overhead IGP account (optional).
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

    // Account 6: Overhead IGP account (optional).
    // The caller is expected to only provide an overhead IGP they are comfortable
    // with / have configured themselves.
    let gas_amount = if let Some(overhead_igp_info) = accounts_iter.next() {
        if overhead_igp_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        let overhead_igp =
            OverheadIgpAccount::fetch(&mut &overhead_igp_info.data.borrow()[..])?.into_inner();
        let overhead_igp_key = Pubkey::create_program_address(
            overhead_igp_pda_seeds!(overhead_igp.salt, overhead_igp.bump_seed),
            program_id,
        )?;
        if overhead_igp_key != *overhead_igp_info.key || overhead_igp.inner != *igp_info.key {
            return Err(ProgramError::InvalidArgument);
        }

        overhead_igp.gas_overhead(payment.destination_domain) + payment.gas_amount
    } else {
        payment.gas_amount
    };

    let required_payment = igp.quote_gas_payment(payment.destination_domain, gas_amount)?;

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
    program_data.payment_count += 1;
    ProgramDataAccount::from(program_data).store(program_data_info, false)?;

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

            // At least one standing PDA must follow.
            if accounts_iter.as_slice().is_empty() {
                return Err(ProgramError::NotEnoughAccountKeys);
            }

            let fee_token_mint = Pubkey::default();
            let clock = Clock::get()?;
            let min_issued_at = igp.fee_config.as_ref().map_or(0, |cfg| cfg.min_issued_at);

            // Cascade walk: standing-only (no transient at quote time).
            let cascade_levels: &[(u32, Pubkey)] = &[
                (payment.destination_domain, *quoted_sender),
                (payment.destination_domain, WILDCARD_SENDER),
                (WILDCARD_DOMAIN, *quoted_sender),
            ];

            let (resolved, overhead_info) = cascade_levels.iter().try_fold(
                (None, None),
                |(resolved, overhead), (domain, sender)| {
                    if resolved.is_some() || overhead.is_some() {
                        return Ok((resolved, overhead));
                    }

                    try_cascade_level(
                        program_id,
                        accounts_iter,
                        igp_info.key,
                        &fee_token_mint,
                        *domain,
                        sender,
                        min_issued_at,
                        &clock,
                    )
                },
            )?;

            // Overhead: detected during cascade or from remaining accounts.
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
    if overhead_igp.inner != *igp_key {
        return Err(ProgramError::InvalidArgument);
    }

    Ok(overhead_igp.gas_overhead(destination_domain) + gas_amount)
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
/// Transient path: not yet supported (will be added in a follow-up commit).
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
    let issued_at_ts = quote.issued_at_timestamp();
    let expiry_ts = quote.expiry_timestamp();

    if expiry_ts < issued_at_ts {
        return Err(QuoteValidationError::InvalidExpiry.into());
    }

    let clock = Clock::get()?;
    if clock.unix_timestamp > expiry_ts {
        return Err(QuoteValidationError::QuoteExpired.into());
    }

    if issued_at_ts > clock.unix_timestamp + MAX_QUOTE_ISSUED_AT_FUTURE_SKEW_SECS {
        return Err(QuoteValidationError::IssuedAtTooFarInFuture.into());
    }

    // Emergency revocation: reject quotes below min_issued_at threshold.
    if issued_at_ts < fee_config.min_issued_at {
        return Err(QuoteValidationError::StaleQuote.into());
    }

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

                if issued_at_ts <= existing.data.issued_at {
                    return Err(QuoteValidationError::StaleStandingQuoteUpdate.into());
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

/// Tries a single cascade level: checks if the next account is a standing quote PDA
/// for the given (domain, sender), or if it's the overhead IGP (cascade done).
/// Returns (resolved_quote, overhead_igp_if_detected).
#[allow(clippy::too_many_arguments)]
fn try_cascade_level<'a, 'b>(
    program_id: &Pubkey,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    igp_key: &Pubkey,
    fee_token_mint: &Pubkey,
    dest_domain: u32,
    sender: &Pubkey,
    min_issued_at: i64,
    clock: &Clock,
) -> Result<(Option<ResolvedQuote>, Option<&'a AccountInfo<'b>>), ProgramError> {
    let account = match accounts_iter.next() {
        None => return Ok((None, None)),
        Some(a) => a,
    };

    // Derive expected standing PDA for this level.
    let dest_le = dest_domain.to_le_bytes();
    let (expected_standing, _) = Pubkey::find_program_address(
        igp_standing_quote_pda_seeds!(igp_key, fee_token_mint, &dest_le, sender),
        program_id,
    );

    if *account.key == expected_standing {
        // Account is the standing PDA for this level.
        let resolved = match account.init_state(program_id) {
            AccountInitState::Uninitialized => None,
            AccountInitState::OwnerMismatch => return Err(ProgramError::IncorrectProgramId),
            AccountInitState::Initialized => {
                let standing =
                    IgpStandingQuoteAccount::fetch(&mut &account.data.borrow()[..])?.into_inner();
                if standing.data.validate_quote(min_issued_at, clock).is_err() {
                    None
                } else {
                    Some(ResolvedQuote {
                        token_exchange_rate: standing.data.token_exchange_rate,
                        gas_price: standing.data.gas_price,
                        token_decimals: standing.data.token_decimals,
                    })
                }
            }
        };
        Ok((resolved, None))
    } else {
        // Not a standing PDA for this level — must be the overhead IGP.
        Ok((None, Some(account)))
    }
}

#[allow(unused, clippy::too_many_arguments)]
/// Tries to resolve a transient quote PDA.
/// Returns Ok(None) if uninitialized, expired, context or payer doesn't match.
/// Re-derives PDA from stored scoped_salt for verification.
fn try_resolve_transient_quote(
    program_id: &Pubkey,
    account_info: &AccountInfo,
    igp_key: &Pubkey,
    payer: &Pubkey,
    dest_domain: u32,
    sender: &Pubkey,
    min_issued_at: i64,
    clock: &Clock,
) -> Result<Option<ResolvedQuote>, ProgramError> {
    match account_info.init_state(program_id) {
        AccountInitState::Uninitialized => Ok(None),
        AccountInitState::OwnerMismatch => Err(ProgramError::IncorrectProgramId),
        AccountInitState::Initialized => {
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
                return Ok(None);
            }

            // Verify stored context matches expected values.
            if transient.data.destination_domain != dest_domain || transient.data.sender != *sender
            {
                return Ok(None);
            }

            // Expired → skip (not error).
            if transient.data.validate_quote(min_issued_at, clock).is_err() {
                return Ok(None);
            }

            Ok(Some(ResolvedQuote {
                token_exchange_rate: transient.data.token_exchange_rate,
                gas_price: transient.data.gas_price,
                token_decimals: transient.data.token_decimals,
            }))
        }
    }
}
