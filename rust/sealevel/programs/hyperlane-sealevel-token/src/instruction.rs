//! Instructions for the program.

use hyperlane_sealevel_token_lib::instruction::{init_instruction as lib_init_instruction, Init};

use crate::{hyperlane_token_ata_payer_pda_seeds, hyperlane_token_mint_pda_seeds};

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
    // 0. `[writable]` The mint / mint authority PDA account.
    // 1. `[writable]` The ATA payer PDA account.

    let (mint_key, _mint_bump) =
        Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);

    let (ata_payer_key, _ata_payer_bump) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), &program_id);

    instruction.accounts.append(&mut vec![
        AccountMeta::new(mint_key, false),
        AccountMeta::new(ata_payer_key, false),
    ]);

    Ok(instruction)
}
