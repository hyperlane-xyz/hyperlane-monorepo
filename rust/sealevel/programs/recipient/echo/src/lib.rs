//! Hyperlane recipient contract that just logs the message data byte vector.
//! **NOT INTENDED FOR USE IN PRODUCTION**
//!
//! Note that a real recipient must define the format for its message and that format is specific
//! to that recipient.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use borsh::ser::BorshSerialize;
use hyperlane_sealevel_mailbox::mailbox_process_authority_pda_seeds;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match MessageRecipientInstruction::decode(instruction_data)? {
        MessageRecipientInstruction::InterchainSecurityModule => {
            // Return None, indicating the default ISM should be used
            let ism: Option<Pubkey> = None;
            set_return_data(
                &ism.try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
            Ok(())
        }
        MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
            // No account metas are required, no return data necessary.
            Ok(())
        }
        MessageRecipientInstruction::Handle(instruction) => {
            handle(program_id, accounts, instruction)
        }
        MessageRecipientInstruction::HandleAccountMetas(_) => {
            // No additional accounts required!
            Ok(())
        }
    }
}

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let process_authority = next_account_info(accounts_iter)?;
    let (expected_process_authority_key, _expected_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &hyperlane_sealevel_mailbox::id(),
        );
    if process_authority.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::InvalidArgument);
    }
    msg!("hyperlane-sealevel-recipient-echo: {:?}", handle);
    Ok(())
}
