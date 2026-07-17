//! Program state processor.
//!
//! This program has no normal client-invokable instructions — its only
//! entrypoint is Circle's real `MessageTransmitterV2` CPI-ing into it as the
//! registered `receiver` for `receive_message`, using one of the two
//! Anchor-sighash discriminators in `circle.rs`. There is no `Init`: state
//! (the per-message `VerifiedMessage` PDA) is created on demand, one per
//! distinct `(sender, message_id)` pair.

use account_utils::{create_pda_account, SizedData};
use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{
        derive_verified_message_pda, VerifiedMessage, VerifiedMessageAccount, VERIFIED_SEED,
    },
    circle::{
        derive_message_transmitter_authority_pda, HandleReceiveMessageParams,
        HANDLE_RECEIVE_FINALIZED_DISCRIMINATOR, HANDLE_RECEIVE_UNFINALIZED_DISCRIMINATOR,
    },
    error::Error,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Marker type for PackageVersioned trait implementation.
pub struct CctpReceiverProgram;
impl package_versioned::PackageVersioned for CctpReceiverProgram {}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if package_versioned::is_get_program_version(instruction_data) {
        return package_versioned::process_get_program_version::<CctpReceiverProgram>();
    }

    if instruction_data.len() < 8 {
        return Err(Error::UnknownInstruction.into());
    }
    let (discriminator, params_data) = instruction_data.split_at(8);
    match discriminator {
        d if d == HANDLE_RECEIVE_FINALIZED_DISCRIMINATOR
            || d == HANDLE_RECEIVE_UNFINALIZED_DISCRIMINATOR =>
        {
            handle_receive_message(program_id, accounts, params_data)
        }
        _ => Err(Error::UnknownInstruction.into()),
    }
}

/// Accounts, in order:
/// 0. `[signer]` `authority_pda` — forwarded by Circle's real program;
///    proves this call genuinely came from Circle's `MessageTransmitterV2`.
/// 1. `[signer, writable]` The payer (funds the verified-message PDA).
/// 2. `[writable]` The verified-message PDA to create, derived from
///    `(params.sender, params.message_body)`.
/// 3. `[]` The system program.
fn handle_receive_message(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    params_data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let authority_info = next_account_info(accounts_iter)?;
    let (expected_authority, _) = derive_message_transmitter_authority_pda(program_id);
    if *authority_info.key != expected_authority {
        return Err(Error::InvalidAuthorityPda.into());
    }
    if !authority_info.is_signer {
        return Err(Error::AuthorityNotSigner.into());
    }

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(Error::PayerNotSigner.into());
    }

    let verified_message_info = next_account_info(accounts_iter)?;

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
    }

    let params = HandleReceiveMessageParams::try_from_slice(params_data)
        .map_err(|_| ProgramError::BorshIoError)?;

    // GMP/hook-message support only: the body must be exactly the 32-byte
    // Hyperlane message ID. Token/burn messages (variable-length, different
    // layout) are out of scope for this program.
    if params.message_body.len() != 32 {
        return Err(Error::InvalidMessageBodyLength.into());
    }
    let mut message_id = [0u8; 32];
    message_id.copy_from_slice(&params.message_body);
    let sender_bytes = params.sender.to_bytes();

    let (expected_key, bump_seed) =
        derive_verified_message_pda(program_id, &sender_bytes, &message_id);
    if *verified_message_info.key != expected_key {
        return Err(Error::InvalidVerifiedMessageAccount.into());
    }
    if !verified_message_info.data_is_empty() {
        return Err(Error::AlreadyInitialized.into());
    }

    let verified = VerifiedMessageAccount::from(VerifiedMessage {
        bump_seed,
        source_domain: params.remote_domain,
    });
    let space = verified.size();
    let rent = Rent::get()?;
    create_pda_account(
        payer_info,
        &rent,
        space,
        program_id,
        system_program_info,
        verified_message_info,
        &[VERIFIED_SEED, &sender_bytes, &message_id, &[bump_seed]],
    )?;
    verified.store(verified_message_info, false)?;

    Ok(())
}
