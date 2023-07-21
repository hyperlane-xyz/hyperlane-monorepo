use borsh::{BorshDeserialize, BorshSerialize};

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
    system_instruction, system_program,
    sysvar::Sysvar,
};

use account_utils::{
    create_pda_account, verify_account_uninitialized, verify_rent_exempt, AccountData, SizedData,
};
use serializable_account_meta::SimulationReturnData;

use crate::{
    accounts::{
        GasPayment, GasPaymentAccount, Igp, IgpAccount, OverheadIgp, OverheadIgpAccount,
        ProgramData, ProgramDataAccount,
    },
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    instruction::{
        InitIgp, InitOverheadIgp, Instruction as IgpInstruction, PayForGas, QuoteGasPayment,
    },
    overhead_igp_pda_seeds,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

/// Entrypoint for the Mailbox program.
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
    }

    Ok(())
}

/// Initializes the program.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer account.
/// 2. [writeable] The program data account.
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

    let program_data_account = ProgramDataAccount::from(ProgramData { payment_count: 0 });
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
/// 1. [signer] The payer account and owner of the IGP account.
/// 2. [writeable] The IGP account to initialize.
fn init_igp(program_id: &Pubkey, accounts: &[AccountInfo], data: InitIgp) -> ProgramResult {
    let igp_key = init_igp_variant(
        program_id,
        accounts,
        |owner| Igp {
            salt: data.salt,
            owner: Some(owner),
            beneficiary: data.beneficiary,
            ..Igp::default()
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
/// 1. [signer] The payer account and owner of the IGP account.
/// 2. [signer, writeable] The Overhead IGP account to initialize.
fn init_overhead_igp(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: InitOverheadIgp,
) -> ProgramResult {
    let igp_key = init_igp_variant(
        program_id,
        accounts,
        |owner| OverheadIgp {
            salt: data.salt,
            owner: Some(owner),
            inner: data.inner,
            ..OverheadIgp::default()
        },
        overhead_igp_pda_seeds!(data.salt),
    )?;

    msg!("Initialized Overhead IGP: {}", igp_key);

    Ok(())
}

fn init_igp_variant<T: account_utils::Data + account_utils::SizedData>(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    get_data: impl FnOnce(Pubkey) -> T,
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

    let igp_account = AccountData::<T>::from(get_data(*payer_info.key));

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
/// 3. [writeable] The IGP account.
/// 4. [signer] Unique gas payment account.
/// 5. [writeable] Gas payment PDA.
/// 6. [] Overhead IGP account (optional).
fn pay_for_gas(program_id: &Pubkey, accounts: &[AccountInfo], payment: PayForGas) -> ProgramResult {
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

    // Account 2: The IGP program data.
    let program_data_info = next_account_info(accounts_iter)?;
    let (program_data_key, program_data_bump) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), program_id);
    if program_data_info.key != &program_data_key {
        return Err(ProgramError::InvalidSeeds);
    }
    if program_data_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut program_data =
        ProgramDataAccount::fetch(&mut &program_data_info.data.borrow()[..])?.into_inner();

    // Account 3: The IGP account.
    let igp_info = next_account_info(accounts_iter)?;
    // The caller should validate the IGP account before paying for gas,
    // but we do a basic sanity check.
    if igp_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    // Account 4: The unique gas payment account.
    // Uniqueness is enforced by making sure the message storage PDA based on
    // this unique message account is empty, which is done next.
    let unique_message_account_info = next_account_info(accounts_iter)?;
    if !unique_message_account_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 5: Gas payment PDA.
    let gas_payment_account_info = next_account_info(accounts_iter)?;
    let (gas_payment_key, gas_payment_bump) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(unique_message_account_info.key),
        program_id,
    );
    if gas_payment_account_info.key != &gas_payment_key {
        return Err(ProgramError::InvalidSeeds);
    }
    // Make sure an account can't be written to that already exists.
    verify_account_uninitialized(gas_payment_account_info)?;

    // Account 6: IGP beneficiary.
    let igp_beneficiary = next_account_info(accounts_iter)?;
    if igp_beneficiary.key != &igp.beneficiary {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 7: Overhead IGP account (optional).
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

    let required_payment = igp.quote_gas_payment(payment.destination_domain, gas_amount)?;

    // Transfer the required payment to the beneficiary.
    invoke(
        &system_instruction::transfer(payer_info.key, igp_beneficiary.key, required_payment),
        &[payer_info.clone(), igp_beneficiary.clone()],
    )?;

    // Increment the payment count.
    program_data.payment_count += 1;

    let gas_payment = GasPayment {
        igp: *igp_info.key,
        sequence_number: program_data.payment_count,
        destination_domain: payment.destination_domain,
        message_id: payment.message_id,
        gas_amount: payment.gas_amount,
        slot: Clock::get()?.slot,
    };
    let gas_payment_size = gas_payment.size();

    let rent = Rent::get()?;

    create_pda_account(
        payer_info,
        &rent,
        gas_payment_size,
        program_id,
        system_program_info,
        gas_payment_account_info,
        igp_gas_payment_pda_seeds!(unique_message_account_info.key, gas_payment_bump),
    )?;

    GasPaymentAccount::from(gas_payment).store(gas_payment_account_info, false)?;

    // Update the program data.
    ProgramDataAccount::from(program_data).store(program_data_info, false)?;

    Ok(())
}

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
        // || igp_info.key != &payment.relayer {
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

fn set_igp_beneficiary(
    
)
