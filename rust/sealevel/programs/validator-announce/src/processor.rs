//! Program processor.

use account_utils::{create_pda_account, SizedData};
use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Announcement, Signable};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    accounts::{
        ReplayProtection, ReplayProtectionAccount, ValidatorAnnounce, ValidatorAnnounceAccount,
        ValidatorStorageLocations, ValidatorStorageLocationsAccount,
    },
    error::Error,
    instruction::{AnnounceInstruction, InitInstruction, Instruction},
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// The entrypoint of the program that processes an instruction.
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
    if !validator_announce_info.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if validator_announce_info.owner != &system_program_id
        || !validator_announce_info.data_is_empty()
    {
        return Err(ProgramError::AccountAlreadyInitialized);
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
    create_pda_account(
        payer_info,
        &Rent::get()?,
        validator_announce_account_size,
        program_id,
        system_program_info,
        validator_announce_info,
        validator_announce_pda_seeds!(validator_announce_bump_seed),
    )?;

    // Store the validator_announce_account.
    validator_announce_account.store(validator_announce_info, false)?;

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

    // Account 4: The ReplayProtection PDA account specific to the announcement being made.
    let replay_protection_info = next_account_info(account_info_iter)?;
    let replay_id = announcement.replay_id();
    let (expected_replay_protection_key, replay_protection_bump_seed) =
        Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), program_id);
    if replay_protection_info.key != &expected_replay_protection_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !replay_protection_info.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    // Verify that the ReplayProtection account is not already initialized.
    // If it is, it means that the announcement has already been made.
    if !replay_protection_info.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Errors if the announcement is not signed by the validator.
    verify_validator_signed_announcement(&announcement, &validator_announce)?;

    // Update the stored storage locations.
    update_validator_storage_locations(
        program_id,
        payer_info,
        system_program_info,
        validator_storage_locations_info,
        &announcement,
    )?;

    // Create the ReplayProtection account so this cannot be announced again.
    create_replay_protection_account(
        program_id,
        payer_info,
        system_program_info,
        replay_protection_info,
        replay_id,
        replay_protection_bump_seed,
    )?;

    Ok(())
}

/// Updates the validator-specific ValidatorStorageLocationsAccount PDA account
/// with the new storage location.
/// The legitimacy of `validator_storage_locations_info` is verified within
/// this function.
/// If the account does not exist, it is created.
/// If the account does exist, the storage location is appended to the existing
/// storage locations.
fn update_validator_storage_locations<'a>(
    program_id: &Pubkey,
    payer_info: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
    validator_storage_locations_info: &AccountInfo<'a>,
    announcement: &AnnounceInstruction,
) -> Result<(), ProgramError> {
    // At this point, we still have not verified the legitimacy of the account info passed in.
    // This is done just below in the if / else.
    let validator_storage_locations_initialized = validator_storage_locations_info.owner
        == program_id
        && !validator_storage_locations_info.data_is_empty();

    let (validator_storage_locations, new_serialized_size) =
        if validator_storage_locations_initialized {
            // If the account is initialized, fetch it and append the storage location.

            let mut validator_storage_locations = ValidatorStorageLocationsAccount::fetch(
                &mut &validator_storage_locations_info.data.borrow()[..],
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
            let new_serialized_size = validator_storage_locations_info.data_len()
                + ValidatorStorageLocations::size_increase_for_new_storage_location(
                    &announcement.storage_location,
                );

            // Append the storage location.
            validator_storage_locations
                .storage_locations
                .push(announcement.storage_location.clone());

            (*validator_storage_locations, new_serialized_size)
        } else {
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
                storage_locations: vec![announcement.storage_location.clone()],
            };
            let validator_storage_locations_account =
                ValidatorStorageLocationsAccount::from(validator_storage_locations);
            let validator_storage_locations_size = validator_storage_locations_account.size();

            // Create the account.
            create_pda_account(
                payer_info,
                &Rent::get()?,
                validator_storage_locations_size,
                program_id,
                system_program_info,
                validator_storage_locations_info,
                validator_storage_locations_pda_seeds!(
                    announcement.validator,
                    validator_storage_locations_bump_seed
                ),
            )?;

            (
                *validator_storage_locations_account.into_inner(),
                validator_storage_locations_size,
            )
        };

    // Because it's possible that a realloc needs to occur, ensure the account
    // would be rent-exempt.
    let existing_serialized_size = validator_storage_locations_info.data_len();
    let required_rent = Rent::get()?.minimum_balance(new_serialized_size);
    let lamports = validator_storage_locations_info.lamports();
    if lamports < required_rent {
        invoke(
            &system_instruction::transfer(
                payer_info.key,
                validator_storage_locations_info.key,
                required_rent - lamports,
            ),
            &[payer_info.clone(), validator_storage_locations_info.clone()],
        )?;
    }
    if existing_serialized_size != new_serialized_size {
        validator_storage_locations_info.realloc(new_serialized_size, false)?;
    }

    // Store the updated validator_storage_locations.
    ValidatorStorageLocationsAccount::from(validator_storage_locations)
        .store(validator_storage_locations_info, false)?;

    Ok(())
}

fn create_replay_protection_account<'a>(
    program_id: &Pubkey,
    payer_info: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
    replay_protection_info: &AccountInfo<'a>,
    replay_id: [u8; 32],
    replay_protection_bump_seed: u8,
) -> Result<(), ProgramError> {
    let replay_protection_account = ReplayProtectionAccount::from(ReplayProtection(()));
    let replay_protection_account_size = replay_protection_account.size();

    // Create the account.
    create_pda_account(
        payer_info,
        &Rent::get()?,
        replay_protection_account_size,
        program_id,
        system_program_info,
        replay_protection_info,
        replay_protection_pda_seeds!(replay_id, replay_protection_bump_seed),
    )?;

    Ok(())
}

fn verify_validator_signed_announcement(
    announce: &AnnounceInstruction,
    validator_announce: &ValidatorAnnounce,
) -> Result<(), ProgramError> {
    let announcement = Announcement {
        validator: announce.validator,
        mailbox_address: validator_announce.mailbox.to_bytes().into(),
        mailbox_domain: validator_announce.local_domain,
        storage_location: announce.storage_location.clone(),
    };
    let announcement_digest = announcement.eth_signed_message_hash();
    let signature = EcdsaSignature::from_bytes(&announce.signature[..])
        .map_err(|_| ProgramError::from(Error::SignatureError))?;

    let recovered_signer = signature
        .secp256k1_recover_ethereum_address(&announcement_digest[..])
        .map_err(|_| ProgramError::from(Error::SignatureError))?;

    if recovered_signer != announcement.validator {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(())
}

#[cfg(test)]
mod test {
    // See tests/functional.rs for the rest of the tests that could not be
    // done as unit tests due to required system program CPIs.

    use hyperlane_core::{H160, H256};
    use std::str::FromStr;

    use super::*;

    #[test]
    fn test_verify_validator_signed_announcement() {
        // Announcement from https://hyperlane-mainnet2-ethereum-validator-0.s3.us-east-1.amazonaws.com/announcement.json

        let announce_instruction = AnnounceInstruction {
            validator: H160::from_str("0x4c327ccb881a7542be77500b2833dc84c839e7b7").unwrap(),
            storage_location: "s3://hyperlane-mainnet2-ethereum-validator-0/us-east-1".to_owned(),
            // The `serialized_signature` component of the announcement,
            // which is the 65-byte serialized ECDSA signature
            signature: hex::decode("20ac937917284eaa3d67287278fc51875874241fffab5eb5fd8ae899a7074c5679be15f0bdb5b4f7594cefc5cba17df59b68ba3c55836053a23307db5a95610d1b").unwrap(),
        };
        let mailbox =
            H256::from_str("0x00000000000000000000000035231d4c2d8b8adcb5617a638a0c4548684c7c70")
                .unwrap();
        let validator_announce = ValidatorAnnounce {
            // Bump seed is not used/verified in this test
            bump_seed: 255,
            mailbox: Pubkey::new_from_array(mailbox.0),
            // The ethereum domain
            local_domain: 1,
        };

        // Expect a successful verification
        assert!(
            verify_validator_signed_announcement(&announce_instruction, &validator_announce)
                .is_ok()
        );

        // Let's change the local domain to something else, expecting an error now
        assert!(verify_validator_signed_announcement(
            &announce_instruction,
            &ValidatorAnnounce {
                local_domain: 2,
                ..validator_announce
            },
        )
        .is_err());

        // Change the validator to something else, also expect an error
        assert!(verify_validator_signed_announcement(
            &AnnounceInstruction {
                validator: H160::random(),
                ..announce_instruction.clone()
            },
            &validator_announce,
        )
        .is_err());

        // Change the storage location to something else, also expect an error
        assert!(verify_validator_signed_announcement(
            &AnnounceInstruction {
                storage_location: "fooooooooooooooo".to_owned(),
                ..announce_instruction
            },
            &validator_announce,
        )
        .is_err());

        // Change the signature to something else, also expect an error
        assert!(verify_validator_signed_announcement(
            &AnnounceInstruction {
                signature: vec![4u8; 65],
                ..announce_instruction
            },
            &validator_announce,
        )
        .is_err());
    }
}
