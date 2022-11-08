//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use hyperlane_sealevel_mailbox::instruction::IsmInstruction;
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

solana_program::declare_id!("6TCwgXydobJUEqabm7e6SL4FMdiFDvp1pmYoL6xXmRJq");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let _ixn = IsmInstruction::from_instruction_data(instruction_data)?;
    msg!("hyperlane-sealevel-ism-rubber-stamp: LGTM!");
    Ok(())
}
