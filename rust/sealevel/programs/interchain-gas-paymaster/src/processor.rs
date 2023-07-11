#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

use crate::instruction::{
    Instruction as IgpInstruction,
    InitRelayer,
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
            msg!("Instruction: InitRelayer");
            init_relayer(program_id, accounts, data)
        }
    }

    Ok(())
}

/// Initialize a new relayer.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer] The payer account and owner of the Relayer account.
/// 2. [writeable] The relayer account to initialize.
fn init_relayer(program_id: &Pubkey, accounts: &[AccountInfo], data: InitRelayer) -> ProgramResult {
    msg!("InitRelayer");
    Ok(())
}
