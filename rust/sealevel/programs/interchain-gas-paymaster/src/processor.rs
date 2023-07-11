#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

/// Entrypoint for the Mailbox program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    Ok(())
}
