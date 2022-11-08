//! Hyperlane recipient contract that just logs the message data byte vector.
//! **NOT INTENDED FOR USE IN PRODUCTION**
//!
//! Note that a real recipient must define the format for its message and that format is specific
//! to that recipient.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use hyperlane_sealevel_mailbox::instruction::RecipientInstruction;
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

solana_program::declare_id!("AziCxohg8Tw46EsZGUCvxsVbqFmJVnSWuEqoTKaAfNiC");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let ixn = RecipientInstruction::from_instruction_data(instruction_data)?;
    msg!("hyperlane-sealevel-recipient-echo: {:?}", ixn);
    Ok(())
}
