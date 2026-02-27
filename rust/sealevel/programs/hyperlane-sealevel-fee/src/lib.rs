#![deny(warnings)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod fee;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };

    entrypoint!(process_instruction);

    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::processor::process_instruction(program_id, accounts, instruction_data)
    }
}
