//! Program state processor.

use borsh::{BorshDeserialize, BorshSerialize};
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
    system_instruction,
    sysvar::Sysvar,
};

use access_control::AccessControl;
use account_utils::{
    create_pda_account, verify_account_uninitialized, verify_rent_exempt, AccountData,
    DiscriminatorPrefixed, SizedData,
};
use serializable_account_meta::SimulationReturnData;

use crate::{
    accounts::{
        GasPaymentAccount, GasPaymentData, Igp, IgpAccount, OverheadIgp, OverheadIgpAccount,
        ProgramData, ProgramDataAccount,
    },
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    instruction::{
        GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp,
        Instruction as IgpInstruction, PayForGas, QuoteGasPayment,
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
    }

    Ok(())
}

/// Initializes the program.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer account.
/// 2. [writeable] The program data PDA account.
fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != solana_program::system_program::id() {
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
/// 0. [executable] The system program.
/// 1. [signer] The payer account.
/// 2. [writeable] The IGP account to initialize.
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
/// 0. [executable] The system program.
/// 1. [signer] The payer account.
/// 2. [writeable] The Overhead IGP account to initialize.
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
    if *system_program_info.key != solana_program::system_program::id() {
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
/// 0. [executable] The system program.
/// 1. [signer] The payer.
/// 2. [writeable] The IGP program data.
/// 3. [signer] Unique gas payment account.
/// 4. [writeable] Gas payment PDA.
/// 5. [writeable] The IGP account.
/// 6. [] Overhead IGP account (optional).
fn pay_for_gas(program_id: &Pubkey, accounts: &[AccountInfo], payment: PayForGas) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != solana_program::system_program::id() {
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
/// Accounts:
/// 0. [executable] The system program.
/// 1. [] The IGP account.
/// 2. [] The overhead IGP account (optional).
fn quote_gas_payment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payment: QuoteGasPayment,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: The IGP account.
    let igp_info = next_account_info(accounts_iter)?;
    // The caller should validate the IGP account before paying for gas,
    // but we do some basic checks here as a sanity check.
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 2: Overhead IGP account (optional).
    // The caller is expected to only provide an overhead IGP they are comfortable
    // with / have configured themselves.
    let gas_amount = if let Some(overhead_igp_info) = accounts_iter.next() {
        if overhead_igp_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        let overhead_igp =
            OverheadIgpAccount::fetch(&mut &overhead_igp_info.data.borrow()[..])?.into_inner();

        if overhead_igp.inner != *igp_info.key {
            return Err(ProgramError::InvalidArgument);
        }

        overhead_igp.gas_overhead(payment.destination_domain) + payment.gas_amount
    } else {
        payment.gas_amount
    };

    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    let required_payment = igp.quote_gas_payment(payment.destination_domain, gas_amount)?;

    set_return_data(&SimulationReturnData::new(required_payment).try_to_vec()?);

    Ok(())
}

/// Sets the beneficiary of an IGP.
///
/// Accounts:
/// 0. [] The IGP.
/// 1. [signer] The owner of the IGP account.
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
/// 0. [writeable] The IGP or OverheadIGP.
/// 1. [signer] The owner of the IGP account.
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
/// 0. [] The IGP variant.
/// 1. [signer] The owner of the IGP variant.
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
/// 0. [executable] The system program.
/// 1. [writeable] The IGP.
/// 2. [writeable] The IGP beneficiary.
fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != solana_program::system_program::id() {
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
/// 0. [executable] The system program.
/// 1. [writeable] The OverheadIGP.
/// 2. [signer] The OverheadIGP owner.
fn set_destination_gas_overheads(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasOverheadConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &solana_program::system_program::id() {
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
/// 0. [executable] The system program.
/// 1. [writeable] The IGP.
/// 2. [signer] The IGP owner.
fn set_gas_oracle_configs(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasOracleConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    // Required to invoke `system_instruction::transfer` in `store_with_rent_exempt_realloc`.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &solana_program::system_program::id() {
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
