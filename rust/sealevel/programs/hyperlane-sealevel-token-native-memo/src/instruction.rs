//! Instructions for the program.

use crate::hyperlane_token_native_collateral_pda_seeds;

use hyperlane_sealevel_token_lib::instruction::{init_instruction as lib_init_instruction, Init};

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
) -> Result<SolanaInstruction, ProgramError> {
    let mut instruction = lib_init_instruction(program_id, payer, init)?;

    // Add additional account metas:
    // 0. `[writable]` The native collateral PDA account.

    let (native_collateral_key, _native_collatera_bump) =
        Pubkey::find_program_address(hyperlane_token_native_collateral_pda_seeds!(), &program_id);

    instruction
        .accounts
        .append(&mut vec![AccountMeta::new(native_collateral_key, false)]);

    Ok(instruction)
}
