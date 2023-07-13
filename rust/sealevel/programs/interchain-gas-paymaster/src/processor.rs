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
    accounts::{GasPayment, GasPaymentAccount, RelayerAccount, RelayerData},
    igp_gas_payment_pda_seeds,
    instruction::{InitRelayer, Instruction as IgpInstruction, PayForGas, QuoteGasPayment},
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
        IgpInstruction::InitRelayer(data) => {
            init_relayer(program_id, accounts, data)?;
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

/// Initialize a new relayer.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer account and owner of the Relayer account.
/// 2. [signer, writeable] The relayer account to initialize.
fn init_relayer(program_id: &Pubkey, accounts: &[AccountInfo], data: InitRelayer) -> ProgramResult {
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

    // Account 2: The relayer account to initialize.
    let relayer_account_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(relayer_account_info)?;

    let relayer_data = RelayerData {
        owner: Some(*payer_info.key),
        beneficiary: data.beneficiary,
        ..RelayerData::default()
    };

    let relayer_data_size = relayer_data.size();

    let rent = Rent::get()?;

    invoke(
        &system_instruction::create_account(
            payer_info.key,
            relayer_account_info.key,
            rent.minimum_balance(relayer_data_size),
            relayer_data_size as u64,
            program_id,
        ),
        &[
            payer_info.clone(),
            relayer_account_info.clone(),
            system_program_info.clone(),
        ],
    )?;

    msg!("Initialized relayer");

    Ok(())
}

/// Pay for gas.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer.
/// 2. [writeable] The relayer account.
/// 3. [signer] Unique gas payment account.
/// 4. [writeable] Gas payment PDA.
fn pay_for_gas(program_id: &Pubkey, accounts: &[AccountInfo], payment: PayForGas) -> ProgramResult {
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

    // Account 2: The relayer account.
    let relayer_account_info = next_account_info(accounts_iter)?;
    // The caller should validate the relayer account before paying for gas,
    // but we do some basic checks here as a sanity check.
    if relayer_account_info.owner != program_id || relayer_account_info.key != &payment.relayer {
        return Err(ProgramError::IncorrectProgramId);
    }

    let relayer = RelayerAccount::fetch(&mut &relayer_account_info.data.borrow()[..])?.into_inner();

    // Account 3: The unique gas payment account.
    // Uniqueness is enforced by making sure the message storage PDA based on
    // this unique message account is empty, which is done next.
    let unique_message_account_info = next_account_info(accounts_iter)?;
    if !unique_message_account_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 4: Gas payment PDA.
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

    let required_payment =
        relayer.quote_gas_payment(payment.destination_domain, payment.gas_amount)?;

    // Transfer the required payment to the relayer.
    invoke(
        &system_instruction::transfer(payer_info.key, relayer_account_info.key, required_payment),
        &[payer_info.clone(), relayer_account_info.clone()],
    )?;

    let gas_payment = GasPayment {
        relayer: payment.relayer,
        sequence_number: 1, // payment.sequence_number,
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

    // Account 2: The relayer account.
    let relayer_account_info = next_account_info(accounts_iter)?;
    // The caller should validate the relayer account before paying for gas,
    // but we do some basic checks here as a sanity check.
    if relayer_account_info.owner != program_id || relayer_account_info.key != &payment.relayer {
        return Err(ProgramError::IncorrectProgramId);
    }

    let relayer = RelayerAccount::fetch(&mut &relayer_account_info.data.borrow()[..])?.into_inner();

    Ok(())
}
