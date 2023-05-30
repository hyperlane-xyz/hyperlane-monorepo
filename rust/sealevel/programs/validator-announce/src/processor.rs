use hyperlane_sealevel_mailbox::accounts::SizedData;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::rent::Rent,
};

use crate::{
    accounts::{
        ValidatorAnnounce, ValidatorAnnounceAccount, ValidatorStorageLocations,
        ValidatorStorageLocationsAccount,
    },
    instruction::{AnnounceInstruction, InitInstruction, Instruction},
    validator_announce_pda_seeds, validator_storage_locations_pda_seeds,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match Instruction::from_instruction_data(instruction_data)? {
        Instruction::Init(init) => {
            process_init(program_id, accounts, init)?;
        }
        Instruction::Announce(announce) => {
            process_announce(program_id, accounts, announce)?;
        }
    }

    Ok(())
}

/// Initializes the program.
///
/// Accounts:
/// 0. [signer] The payer.
/// 1. [executable] The system program.
/// 2. [writable] The ValidatorAnnounce PDA account.
pub fn process_init(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    init: InitInstruction,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let system_program_id = solana_program::system_program::id();

    // Account 0: The payer.
    let payer_info = next_account_info(account_info_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: The system program.
    let system_program_info = next_account_info(account_info_iter)?;
    if system_program_info.key != &system_program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 2: The ValidatorAnnounce PDA account.
    let validator_announce_info = next_account_info(account_info_iter)?;
    if !validator_announce_info.is_writable
        || validator_announce_info.owner != &system_program_id
        || !validator_announce_info.data_is_empty()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (validator_announce_key, validator_announce_bump_seed) =
        Pubkey::find_program_address(validator_announce_pda_seeds!(), program_id);
    if validator_announce_info.key != &validator_announce_key {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Create the validator announce account.
    let validator_announce = ValidatorAnnounce {
        bump_seed: validator_announce_bump_seed,
        mailbox: init.mailbox,
        local_domain: init.local_domain,
    };
    let validator_announce_account = ValidatorAnnounceAccount::from(validator_announce);
    let validator_announce_account_size = validator_announce_account.size();
    invoke_signed(
        &system_instruction::create_account(
            payer_info.key,
            validator_announce_info.key,
            Rent::default().minimum_balance(validator_announce_account_size),
            validator_announce_account_size.try_into().unwrap(),
            program_id,
        ),
        &[payer_info.clone(), validator_announce_info.clone()],
        &[validator_announce_pda_seeds!(validator_announce_bump_seed)],
    )?;

    Ok(())
}

/// Announces a validator.
///
/// Accounts:
/// 0. [signer] The payer.
/// 1. [executable] The system program.
/// 2. [] The ValidatorAnnounce PDA account.
/// 3. [writeable] The validator-specific ValidatorStorageLocationsAccount PDA account.
/// 4. [writeable] The ReplayProtection PDA account specific to the announcement being made.
fn process_announce(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    announcement: AnnounceInstruction,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let system_program_id = solana_program::system_program::id();

    // Account 0: The payer.
    let payer_info = next_account_info(account_info_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: The system program.
    let system_program_info = next_account_info(account_info_iter)?;
    if system_program_info.key != &system_program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 2: The ValidatorAnnounce PDA account.
    let validator_announce_info = next_account_info(account_info_iter)?;
    let validator_announce =
        ValidatorAnnounceAccount::fetch(&mut &validator_announce_info.data.borrow()[..])?
            .into_inner();
    // Verify the legitimacy of the account.
    validator_announce.verify_self_account_info(program_id, validator_announce_info)?;

    // Account 3: The validator-specific ValidatorStorageLocationsAccount PDA account.
    let validator_storage_locations_info = next_account_info(account_info_iter)?;

    // At this point, we still have not verified the legitimacy of the account info passed in.
    let validator_storage_locations_initialized = validator_storage_locations_info.owner
        == program_id
        && !validator_storage_locations_info.data_is_empty();

    let (validator_storage_locations, new_serialized_size) =
        if !validator_storage_locations_initialized {
            // If not initialized, we need to create the account.

            let (validator_storage_locations_key, validator_storage_locations_bump_seed) =
                Pubkey::find_program_address(
                    validator_storage_locations_pda_seeds!(announcement.validator),
                    program_id,
                );
            // Verify the ID of the account using `find_program_address`.
            if validator_storage_locations_info.key != &validator_storage_locations_key {
                return Err(ProgramError::IncorrectProgramId);
            }

            let validator_storage_locations = ValidatorStorageLocations {
                bump_seed: validator_storage_locations_bump_seed,
                storage_locations: vec![announcement.storage_location],
            };
            let validator_storage_locations_account =
                ValidatorStorageLocationsAccount::from(validator_storage_locations);
            let validator_storage_locations_size = validator_storage_locations_account.size();

            // Create the account.
            // We init with a size of 0 and later realloc if necessary.
            invoke_signed(
                &system_instruction::create_account(
                    payer_info.key,
                    validator_storage_locations_info.key,
                    Rent::default().minimum_balance(validator_storage_locations_size),
                    validator_storage_locations_size.try_into().unwrap(),
                    program_id,
                ),
                &[payer_info.clone(), validator_storage_locations_info.clone()],
                &[validator_storage_locations_pda_seeds!(
                    announcement.validator,
                    validator_storage_locations_bump_seed
                )],
            )?;

            (
                *validator_storage_locations_account.into_inner(),
                validator_storage_locations_size,
            )
        } else {
            let mut validator_storage_locations = ValidatorStorageLocationsAccount::fetch(
                &mut &validator_announce_info.data.borrow()[..],
            )?
            .into_inner();

            // Verify the ID of the account using `create_program_address` and the stored bump seed.
            let expected_validator_storage_locations_key = Pubkey::create_program_address(
                validator_storage_locations_pda_seeds!(
                    announcement.validator,
                    validator_storage_locations.bump_seed
                ),
                program_id,
            )?;
            if validator_storage_locations_info.key != &expected_validator_storage_locations_key {
                return Err(ProgramError::IncorrectProgramId);
            }

            // Calculate the new serialized size.
            // The only difference is the new storage location, which is Borsh-serialized
            // as the u32 length of the string + u32 length of the serialized Vec<u8> + the Vec<u8> it is serialized
            // into. See https://borsh.io/ for details.
            let new_serialized_size =
                validator_announce_info.data_len() + 4 + announcement.storage_location.len();

            // Append the storage location.
            validator_storage_locations
                .storage_locations
                .push(announcement.storage_location);

            (*validator_storage_locations, new_serialized_size)
        };

    // Because it's possible that a realloc occurred, ensure the account
    // is still rent-exempt.
    let existing_serialized_size = validator_announce_info.data_len();
    let required_rent = Rent::default().minimum_balance(new_serialized_size);
    let lamports = validator_announce_info.lamports();
    if lamports < required_rent {
        invoke(
            &system_instruction::transfer(
                payer_info.key,
                validator_announce_info.key,
                required_rent - lamports,
            ),
            &[payer_info.clone(), validator_announce_info.clone()],
        )?;
    }
    if existing_serialized_size != new_serialized_size {
        validator_announce_info.realloc(new_serialized_size, false)?;
    }

    // Store the updated validator_storage_locations.
    ValidatorStorageLocationsAccount::from(validator_storage_locations)
        .store(validator_announce_info, false)?;

    Ok(())
}
