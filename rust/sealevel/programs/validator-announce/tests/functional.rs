use hyperlane_core::{Announcement, H160};

use std::str::FromStr;

use account_utils::SizedData;
use borsh::BorshSerialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError, signature::Signer, signer::keypair::Keypair,
    transaction::TransactionError,
};

use hyperlane_sealevel_validator_announce::{
    accounts::{
        ReplayProtection, ReplayProtectionAccount, ValidatorAnnounce, ValidatorAnnounceAccount,
        ValidatorStorageLocations, ValidatorStorageLocationsAccount,
    },
    instruction::{
        AnnounceInstruction, InitInstruction, Instruction as ValidatorAnnounceInstruction,
    },
    processor::process_instruction as validator_announce_process_instruction,
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};
use hyperlane_test_utils::{assert_transaction_error, process_instruction};

// The Ethereum mailbox & domain chosen for easy testing
const TEST_MAILBOX: &str = "00000000000000000000000035231d4c2d8b8adcb5617a638a0c4548684c7c70";
const TEST_DOMAIN: u32 = 1;

fn validator_announce_id() -> Pubkey {
    pubkey!("DH43ae1LwemXAboWwSh8zc9pG8j72gKUEXNi57w8fEnn")
}

fn get_test_mailbox() -> Pubkey {
    let mailbox_bytes = hex::decode(TEST_MAILBOX).unwrap();
    Pubkey::new(&mailbox_bytes[..])
}

fn get_test_announcements() -> Vec<(Announcement, Vec<u8>)> {
    // Signed by the following validator:
    //
    // Address: 0x13DFDeB827D4D7fACE707fAdbfd4D651438B4aB3
    // Private Key: 0x2053099fadf2520efd407cbf043f89fe10eaf91a356d585e9ad12a5eb5f771dd

    let announcement0 = Announcement {
        validator: H160::from_str("0x13DFDeB827D4D7fACE707fAdbfd4D651438B4aB3").unwrap(),
        mailbox_address: get_test_mailbox().to_bytes().into(),
        mailbox_domain: TEST_DOMAIN,
        storage_location: "s3://test-storage-location-foo/us-east-1".to_string(),
    };
    // Got using ethers.js to sign `announcement0.signing_hash()`, which is
    // 0x6a4f7bcbbcf3f700c4f4da16d3d14ae907ced31d79779e196f4f40af710cfa85
    //
    // > await (new ethers.Wallet('0x2053099fadf2520efd407cbf043f89fe10eaf91a356d585e9ad12a5eb5f771dd')).signMessage(ethers.utils.arrayify('0x6a4f7bcbbcf3f700c4f4da16d3d14ae907ced31d79779e196f4f40af710cfa85'))
    let signature0 = hex::decode("fa0d375457d9a98b3cd6c6ee308464ea23abc2f2368e80d942dacf0b2e3cc4d66ac51efabe169b7cb29170894c588221c91807e500a7a9f9648a8b1c47eceecc1c").unwrap();

    // UTF-8 characters in the storage location
    let announcement1 = Announcement {
        validator: H160::from_str("0x13DFDeB827D4D7fACE707fAdbfd4D651438B4aB3").unwrap(),
        mailbox_address: get_test_mailbox().to_bytes().into(),
        mailbox_domain: TEST_DOMAIN,
        storage_location: "s3://test-storage-location-Здравствуйте/us-east-1".to_string(),
    };
    // Got using ethers.js to sign `announcement1.signing_hash()`, which is
    // 0xb647a8e18b8152d7cc122ef3e88b643a0dcd2b702dded70ac2d1c94477ca3090
    //
    // > await (new ethers.Wallet('0x2053099fadf2520efd407cbf043f89fe10eaf91a356d585e9ad12a5eb5f771dd')).signMessage(ethers.utils.arrayify('0xb647a8e18b8152d7cc122ef3e88b643a0dcd2b702dded70ac2d1c94477ca3090'))
    let signature1 = hex::decode("983b941ae9bf939bf59abcf81e7d2e66735da5e2726f955b915aea247ae16afa3a03b69fe7d7c83154caca29d8ad62f2a1ccbbb5c56f67dab10c98a2d4aac3b01c").unwrap();

    vec![(announcement0, signature0), (announcement1, signature1)]
}

async fn initialize(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox: Pubkey,
) -> Result<(Pubkey, u8), BanksClientError> {
    let program_id = validator_announce_id();

    let (validator_announce_key, validator_announce_bump_seed) =
        Pubkey::find_program_address(validator_announce_pda_seeds!(), &program_id);

    // Accounts:
    // 0. [signer] The payer.
    // 1. [executable] The system program.
    // 2. [writable] The ValidatorAnnounce PDA account.
    let init_instruction = Instruction::new_with_borsh(
        program_id,
        &ValidatorAnnounceInstruction::Init(InitInstruction {
            mailbox,
            local_domain: TEST_DOMAIN,
        }),
        vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(validator_announce_key, false),
        ],
    );

    process_instruction(banks_client, init_instruction, payer, &[payer]).await?;

    Ok((validator_announce_key, validator_announce_bump_seed))
}

#[tokio::test]
async fn test_initialize() {
    let program_id = validator_announce_id();
    let (mut banks_client, payer, _recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_validator_announce",
        program_id,
        processor!(validator_announce_process_instruction),
    )
    .start()
    .await;

    let mailbox = get_test_mailbox();
    let (validator_announce_key, validator_announce_bump_seed) =
        initialize(&mut banks_client, &payer, mailbox)
            .await
            .unwrap();

    // Expect the validator announce account to be initialized.
    let validator_announce_account = banks_client
        .get_account(validator_announce_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(validator_announce_account.owner, program_id);

    let validator_announce =
        ValidatorAnnounceAccount::fetch(&mut &validator_announce_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        validator_announce,
        Box::new(ValidatorAnnounce {
            bump_seed: validator_announce_bump_seed,
            mailbox,
            local_domain: TEST_DOMAIN,
        }),
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = validator_announce_id();
    let (mut banks_client, payer, _recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_validator_announce",
        program_id,
        processor!(validator_announce_process_instruction),
    )
    .start()
    .await;

    let mailbox = get_test_mailbox();
    initialize(&mut banks_client, &payer, mailbox)
        .await
        .unwrap();

    // Using the same mailbox / payer in the new initialize will result in the same
    // tx hash because a new blockhash isn't used for the new transaction.
    // As a workaround, use a different mailbox
    let init_result = initialize(&mut banks_client, &payer, Pubkey::new_unique()).await;

    assert_transaction_error(
        init_result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

async fn announce(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    program_id: Pubkey,
    validator_announce_key: Pubkey,
    announce_instruction: AnnounceInstruction,
) -> Result<(Pubkey, u8, Pubkey, u8), BanksClientError> {
    let (validator_storage_locations_key, validator_storage_locations_bump_seed) =
        Pubkey::find_program_address(
            validator_storage_locations_pda_seeds!(announce_instruction.validator),
            &program_id,
        );

    let replay_id = announce_instruction.replay_id();

    let (replay_protection_key, replay_protection_bump_seed) =
        Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), &program_id);

    // Accounts:
    // 0. [signer] The payer.
    // 1. [executable] The system program.
    // 2. [] The ValidatorAnnounce PDA account.
    // 3. [writeable] The validator-specific ValidatorStorageLocationsAccount PDA account.
    // 4. [writeable] The ReplayProtection PDA account specific to the announcement being made.
    let announce_instruction = Instruction::new_with_borsh(
        program_id,
        &ValidatorAnnounceInstruction::Announce(announce_instruction),
        vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(validator_announce_key, false),
            AccountMeta::new(validator_storage_locations_key, false),
            AccountMeta::new(replay_protection_key, false),
        ],
    );

    process_instruction(banks_client, announce_instruction, payer, &[payer]).await?;

    Ok((
        validator_storage_locations_key,
        validator_storage_locations_bump_seed,
        replay_protection_key,
        replay_protection_bump_seed,
    ))
}

async fn assert_successful_announcement(
    banks_client: &mut BanksClient,
    program_id: Pubkey,
    validator_storage_locations_key: Pubkey,
    replay_protection_key: Pubkey,
    expected_validator_storage_locations: ValidatorStorageLocations,
) {
    // Expect the validator storage locations account to be created & with the new announcement.
    let validator_storage_locations_account = banks_client
        .get_account(validator_storage_locations_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(validator_storage_locations_account.owner, program_id);

    let validator_storage_locations =
        ValidatorStorageLocationsAccount::fetch(&mut &validator_storage_locations_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        validator_storage_locations,
        Box::new(expected_validator_storage_locations.clone()),
    );
    // Also sanity check that the sizing logic is correct!
    assert_eq!(
        validator_storage_locations_account.data.len(),
        // Plus 1 for the initialized byte
        expected_validator_storage_locations
            .try_to_vec()
            .unwrap()
            .len()
            + 1,
    );
    assert_eq!(
        validator_storage_locations_account.data.len(),
        ValidatorStorageLocationsAccount::from(expected_validator_storage_locations).size(),
    );

    // Expect the replay protection account to be created
    let replay_protection_account = banks_client
        .get_account(replay_protection_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay_protection_account.owner, program_id);

    assert!(!validator_storage_locations_account.data.is_empty());
    let replay_protection =
        ReplayProtectionAccount::fetch_data(&mut &validator_storage_locations_account.data[..])
            .unwrap();
    assert_eq!(replay_protection, Some(Box::new(ReplayProtection(()))),);
}

#[tokio::test]
async fn test_announce() {
    let program_id = validator_announce_id();
    let (mut banks_client, payer, _recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_validator_announce",
        program_id,
        processor!(validator_announce_process_instruction),
    )
    .start()
    .await;

    let mailbox = get_test_mailbox();
    let (validator_announce_key, _validator_announce_bump_seed) =
        initialize(&mut banks_client, &payer, mailbox)
            .await
            .unwrap();

    let test_announcements = get_test_announcements();

    // Make the first announcement
    let (announcement, signature) = test_announcements[0].clone();
    let announce_instruction = AnnounceInstruction {
        validator: announcement.validator,
        storage_location: announcement.storage_location,
        signature,
    };
    let (
        validator_storage_locations_key,
        validator_storage_locations_bump_seed,
        replay_protection_key,
        _replay_protection_bump_seed,
    ) = announce(
        &mut banks_client,
        &payer,
        program_id,
        validator_announce_key,
        announce_instruction.clone(),
    )
    .await
    .unwrap();

    assert_successful_announcement(
        &mut banks_client,
        program_id,
        validator_storage_locations_key,
        replay_protection_key,
        ValidatorStorageLocations {
            bump_seed: validator_storage_locations_bump_seed,
            storage_locations: vec![announce_instruction.storage_location.clone()],
        },
    )
    .await;

    // And ensure that the announcement can't be made again!
    let announce_result = announce(
        &mut banks_client,
        &payer,
        program_id,
        validator_announce_key,
        announce_instruction.clone(),
    )
    .await;
    assert_transaction_error(
        announce_result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );

    // And then announce the second storage location, which we expect to be successful
    let (announcement, signature) = test_announcements[1].clone();
    let announce_instruction1 = AnnounceInstruction {
        validator: announcement.validator,
        storage_location: announcement.storage_location,
        signature,
    };

    let (_, _, replay_protection_key, _replay_protection_bump_seed) = announce(
        &mut banks_client,
        &payer,
        program_id,
        validator_announce_key,
        announce_instruction1.clone(),
    )
    .await
    .unwrap();

    assert_successful_announcement(
        &mut banks_client,
        program_id,
        validator_storage_locations_key,
        replay_protection_key,
        ValidatorStorageLocations {
            bump_seed: validator_storage_locations_bump_seed,
            storage_locations: vec![
                announce_instruction.storage_location.clone(),
                announce_instruction1.storage_location.clone(),
            ],
        },
    )
    .await;
}
