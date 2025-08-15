//! Instructions for the program.

use hyperlane_sealevel_token_lib::instruction::{init_instruction as lib_init_instruction, Init};

use crate::{hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds};

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::SysvarId,
};

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
    spl_program: Pubkey,
    mint: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let mut instruction = lib_init_instruction(program_id, payer, init)?;

    // Add additional account metas:
    // 0. `[executable]` The SPL token program for the mint, i.e. either SPL token program or the 2022 version.
    // 1. `[]` The mint.
    // 2. `[executable]` The Rent sysvar program.
    // 3. `[writable]` The escrow PDA account.
    // 4. `[writable]` The ATA payer PDA account.

    let (escrow_key, _escrow_bump) =
        Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), &program_id);

    let (ata_payer_key, _ata_payer_bump) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), &program_id);

    instruction.accounts.append(&mut vec![
        AccountMeta::new_readonly(spl_program, false),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(Rent::id(), false),
        AccountMeta::new(escrow_key, false),
        AccountMeta::new(ata_payer_key, false),
    ]);

    Ok(instruction)
}
