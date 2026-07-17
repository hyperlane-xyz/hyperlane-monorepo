//! Program state processor.

use access_control::AccessControl;
use account_utils::{create_pda_account, verify_account_uninitialized, SizedData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{
        derive_program_data_pda, derive_remote_config_pda, derive_sender_authority_pda,
        ProgramData, ProgramDataAccount, RemoteConfig, RemoteConfigAccount,
    },
    cctp_hook_sender_authority_pda_seeds,
    circle::send_message_instruction,
    error::Error,
    instruction::{Instruction, SendMessageId, SetRemoteConfig},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Marker type for PackageVersioned trait implementation.
pub struct CctpHookProgram;
impl package_versioned::PackageVersioned for CctpHookProgram {}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if package_versioned::is_get_program_version(instruction_data) {
        return package_versioned::process_get_program_version::<CctpHookProgram>();
    }

    match Instruction::from_instruction_data(instruction_data)? {
        Instruction::Init(data) => init(program_id, accounts, data.owner),
        Instruction::SetRemoteConfig(data) => set_remote_config(program_id, accounts, data),
        Instruction::SendMessageId(data) => send_message_id(program_id, accounts, data),
    }
}

/// Accounts:
/// 0. `[]` The system program.
/// 1. `[signer]` The payer.
/// 2. `[writable]` The program data PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo], owner: Option<Pubkey>) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
    }

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let program_data_info = next_account_info(accounts_iter)?;
    verify_account_uninitialized(program_data_info)?;
    let (program_data_key, program_data_bump) = derive_program_data_pda(program_id);
    if *program_data_info.key != program_data_key {
        return Err(Error::InvalidProgramDataAccount.into());
    }

    let program_data = ProgramDataAccount::from(ProgramData {
        bump_seed: program_data_bump,
        owner,
    });
    let space = program_data.size();
    let rent = Rent::get()?;
    create_pda_account(
        payer_info,
        &rent,
        space,
        program_id,
        system_program_info,
        program_data_info,
        crate::cctp_hook_program_data_pda_seeds!(program_data_bump),
    )?;
    program_data.store(program_data_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. `[]` The system program.
/// 1. `[]` The program data PDA (for owner check).
/// 2. `[signer]` The owner.
/// 3. `[signer, writable]` The payer (funds the remote config PDA if new).
/// 4. `[writable]` The remote config PDA for `data.destination_domain`.
fn set_remote_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: SetRemoteConfig,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
    }

    let program_data_info = next_account_info(accounts_iter)?;
    let (program_data_key, _) = derive_program_data_pda(program_id);
    if *program_data_info.key != program_data_key {
        return Err(Error::InvalidProgramDataAccount.into());
    }
    let program_data = ProgramDataAccount::fetch_data(&mut &program_data_info.data.borrow()[..])?
        .ok_or(Error::AccountNotInitialized)?;

    let owner_info = next_account_info(accounts_iter)?;
    program_data.ensure_owner_signer(owner_info)?;

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let remote_config_info = next_account_info(accounts_iter)?;
    let (remote_config_key, remote_config_bump) =
        derive_remote_config_pda(program_id, data.destination_domain);
    if *remote_config_info.key != remote_config_key {
        return Err(Error::InvalidRemoteConfigAccount.into());
    }

    let remote_config = RemoteConfigAccount::from(RemoteConfig {
        bump_seed: remote_config_bump,
        circle_domain: data.circle_domain,
        recipient: data.recipient,
        destination_caller: data.destination_caller,
        min_finality_threshold: data.min_finality_threshold,
    });

    if remote_config_info.data_is_empty() {
        let space = remote_config.size();
        let rent = Rent::get()?;
        let domain_bytes = data.destination_domain.to_le_bytes();
        create_pda_account(
            payer_info,
            &rent,
            space,
            program_id,
            system_program_info,
            remote_config_info,
            crate::cctp_hook_remote_config_pda_seeds!(&domain_bytes, remote_config_bump),
        )?;
    }
    remote_config.store(remote_config_info, true)?;

    Ok(())
}

/// Accounts:
/// 0. `[]` The remote config PDA for `data.destination_domain`.
/// 1. `[signer, writable]` The payer (Circle's `event_rent_payer`).
/// 2. `[]` This program's `sender_authority` PDA.
/// 3. `[]` This program's own executable account (Circle's `sender_program`).
/// 4. `[]` The system program.
/// 5. `[]` Circle's `MessageTransmitterV2` program.
/// 6. `[writable]` Circle's `message_transmitter` config PDA.
/// 7. `[signer, writable]` A fresh, uninitialized account for Circle's
///    `message_sent_event_data`.
fn send_message_id(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: SendMessageId,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let remote_config_info = next_account_info(accounts_iter)?;
    let (remote_config_key, _) = derive_remote_config_pda(program_id, data.destination_domain);
    if *remote_config_info.key != remote_config_key {
        return Err(Error::InvalidRemoteConfigAccount.into());
    }
    let remote_config =
        RemoteConfigAccount::fetch_data(&mut &remote_config_info.data.borrow()[..])?
            .ok_or(Error::RemoteConfigNotSet)?;

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let sender_authority_info = next_account_info(accounts_iter)?;
    let (sender_authority_key, sender_authority_bump) = derive_sender_authority_pda(program_id);
    if *sender_authority_info.key != sender_authority_key {
        return Err(Error::InvalidSenderAuthority.into());
    }

    let sender_program_info = next_account_info(accounts_iter)?;
    if sender_program_info.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
    }

    let circle_program_info = next_account_info(accounts_iter)?;
    if *circle_program_info.key != crate::circle::ID {
        return Err(Error::InvalidCircleProgram.into());
    }

    let message_transmitter_info = next_account_info(accounts_iter)?;
    let (message_transmitter_key, _) = crate::circle::derive_message_transmitter_pda();
    if *message_transmitter_info.key != message_transmitter_key {
        return Err(Error::InvalidCircleProgram.into());
    }

    let message_sent_event_data_info = next_account_info(accounts_iter)?;
    if !message_sent_event_data_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let ixn = send_message_instruction(
        *payer_info.key,
        sender_authority_key,
        *message_sent_event_data_info.key,
        *program_id,
        system_program::ID,
        remote_config.circle_domain,
        Pubkey::new_from_array(remote_config.recipient),
        Pubkey::new_from_array(remote_config.destination_caller),
        remote_config.min_finality_threshold,
        data.message_id.as_bytes().to_vec(),
    )?;

    invoke_signed(
        &ixn,
        &[
            payer_info.clone(),
            sender_authority_info.clone(),
            message_transmitter_info.clone(),
            message_sent_event_data_info.clone(),
            sender_program_info.clone(),
            system_program_info.clone(),
        ],
        &[cctp_hook_sender_authority_pda_seeds!(sender_authority_bump)],
    )?;

    Ok(())
}
