use borsh::BorshDeserialize;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use account_utils::{
    create_pda_account, verify_account_uninitialized, verify_rent_exempt, SizedData,
};

use crate::{
    accounts::{
        GasPayment, GasPaymentAccount, IgpAccount, IgpData, OverheadIgp, OverheadIgpAccount,
        ProgramData, ProgramDataAccount,
    },
    igp_gas_payment_pda_seeds, igp_program_data_pda_seeds,
    instruction::{InitIgp, Instruction as IgpInstruction, PayForGas, QuoteGasPayment},
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
        IgpInstruction::InitIgp(data) => {
            init_igp(program_id, accounts, data)?;
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

/// Initialize a new IGP account.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer account and owner of the IGP account.
/// 2. [signer, writeable] The IGP account to initialize.
fn init_igp(program_id: &Pubkey, accounts: &[AccountInfo], data: InitIgp) -> ProgramResult {
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

    // Account 2: The IGP account to initialize.
    // TODO make this a PDA!
    let igp_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(igp_info)?;

    let igp_data = IgpData {
        owner: Some(*payer_info.key),
        beneficiary: data.beneficiary,
        ..IgpData::default()
    };

    let igp_data_size = igp_data.size();

    let rent = Rent::get()?;

    invoke(
        &system_instruction::create_account(
            payer_info.key,
            igp_info.key,
            rent.minimum_balance(igp_data_size),
            igp_data_size as u64,
            program_id,
        ),
        &[
            payer_info.clone(),
            igp_info.clone(),
            system_program_info.clone(),
        ],
    )?;

    msg!("Initialized IGP");

    Ok(())
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
    // TODO does this still make sense
    // The caller should validate the IGP account before paying for gas,
    // but we do some basic checks here as a sanity check.
    if igp_info.owner != program_id {
        // || igp_info.key != &payment.igp {
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

    // Account 6: Overhead IGP account (optional).
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
        &system_instruction::transfer(payer_info.key, igp_info.key, required_payment),
        &[payer_info.clone(), igp_info.clone()],
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

    // Account 1: The payer account and owner of the Relayer account.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: The IGP account.
    let igp_info = next_account_info(accounts_iter)?;
    // The caller should validate the IGP account before paying for gas,
    // but we do some basic checks here as a sanity check.
    if igp_info.owner != program_id {
        // || igp_info.key != &payment.relayer {
        return Err(ProgramError::IncorrectProgramId);
    }

    let igp = IgpAccount::fetch(&mut &igp_info.data.borrow()[..])?.into_inner();

    Ok(())
}
