//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use account_utils::DiscriminatorEncode;
use borsh::BorshDeserialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};

use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Encode, HyperlaneMessage, ModuleType, H160, H256};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds,
    accounts::{AccessControlAccount, AccessControlData, DomainData, DomainDataAccount},
    domain_data_pda_seeds,
    error::Error as MultisigIsmError,
    instruction::{Domained, Instruction as MultisigIsmProgramInstruction, ValidatorsAndThreshold},
    metadata::MultisigIsmMessageIdMetadata,
    processor::process_instruction,
};
use hyperlane_test_utils::assert_transaction_error;
use multisig_ism::interface::{
    MultisigIsmInstruction, VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
};
#[cfg(test)]
use multisig_ism::test_data::{get_multisig_ism_test_data, MultisigIsmTestData};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program_test::*;
use solana_sdk::{
    hash::Hash,
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

pub fn multisig_ism_message_id_id() -> Pubkey {
    pubkey!("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw")
}

async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            &keypair.pubkey(),
            lamports,
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
    keypair
}

async fn initialize(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> Result<(Pubkey, u8), BanksClientError> {
    let (access_control_pda_key, _access_control_pda_bump_seed) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MultisigIsmProgramInstruction::Initialize.encode().unwrap(),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(access_control_pda_key, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    Ok((access_control_pda_key, _access_control_pda_bump_seed))
}

async fn set_validators_and_threshold(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    access_control_pda_key: Pubkey,
    domain: u32,
    validators_and_threshold: ValidatorsAndThreshold,
) -> Result<(Pubkey, u8), BanksClientError> {
    let (domain_data_pda_key, domain_data_pda_bump_seed) =
        Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MultisigIsmProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain,
                data: validators_and_threshold.clone(),
            })
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    Ok((domain_data_pda_key, domain_data_pda_bump_seed))
}

#[tokio::test]
async fn test_initialize() {
    let program_id = multisig_ism_message_id_id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, access_control_pda_bump_seed) =
        initialize(program_id, &mut banks_client, &payer, recent_blockhash)
            .await
            .unwrap();

    let access_control_account_data = banks_client
        .get_account(access_control_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let access_control = AccessControlAccount::fetch_data(&mut &access_control_account_data[..])
        .unwrap()
        .unwrap();
    assert_eq!(
        access_control,
        Box::new(AccessControlData {
            bump_seed: access_control_pda_bump_seed,
            owner: Some(payer.pubkey()),
        }),
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = multisig_ism_message_id_id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    initialize(program_id, &mut banks_client, &payer, recent_blockhash)
        .await
        .unwrap();

    // Create a new payer as a hack to get a new tx ID, because the
    // instruction data is the same and the recent blockhash is the same
    let new_payer = new_funded_keypair(&mut banks_client, &payer, 1000000).await;
    let result = initialize(program_id, &mut banks_client, &new_payer, recent_blockhash).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(MultisigIsmError::AlreadyInitialized as u32),
        ),
    );
}

#[tokio::test]
async fn test_set_validators_and_threshold_creates_pda_account() {
    let program_id = multisig_ism_message_id_id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, _) =
        initialize(program_id, &mut banks_client, &payer, recent_blockhash)
            .await
            .unwrap();

    let domain: u32 = 1234;

    let validators_and_threshold = ValidatorsAndThreshold {
        validators: vec![H160::random(), H160::random(), H160::random()],
        threshold: 2,
    };

    let (domain_data_pda_key, domain_data_pda_bump_seed) = set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        domain,
        validators_and_threshold.clone(),
    )
    .await
    .unwrap();

    let domain_data_account_data = banks_client
        .get_account(domain_data_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let domain_data = DomainDataAccount::fetch_data(&mut &domain_data_account_data[..])
        .unwrap()
        .unwrap();
    assert_eq!(
        domain_data,
        Box::new(DomainData {
            bump_seed: domain_data_pda_bump_seed,
            validators_and_threshold,
        }),
    );

    // And now for good measure, try to set the validators and threshold again after the domain data
    // PDA has been created. By not passing in the system program, we can be sure that
    // the create_account path certainly doesn't get hit

    // Change it up
    let validators_and_threshold = ValidatorsAndThreshold {
        validators: vec![H160::random(), H160::random(), H160::random()],
        threshold: 1,
    };

    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MultisigIsmProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain,
                data: validators_and_threshold.clone(),
            })
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    let domain_data_account_data = banks_client
        .get_account(domain_data_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let domain_data = DomainDataAccount::fetch_data(&mut &domain_data_account_data[..])
        .unwrap()
        .unwrap();
    assert_eq!(
        domain_data,
        Box::new(DomainData {
            bump_seed: domain_data_pda_bump_seed,
            validators_and_threshold: validators_and_threshold.clone(),
        }),
    );

    // For good measure, let's also use the MultisigIsmInstruction::ValidatorsAndThreshold
    // instruction, and also use the MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas
    // to fetch the account metas required for the instruction.

    let test_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: domain,
        sender: H256::random(),
        destination: domain + 1,
        recipient: H256::random(),
        body: vec![1, 2, 3, 4, 5],
    };

    // First, call MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas to get the metas
    // for our future call to MultisigIsmInstruction::ValidatorsAndThreshold
    let (account_metas_pda_key, _) = Pubkey::find_program_address(
        VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
        &program_id,
    );
    let account_metas_return_data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(test_message.to_vec())
                    .encode()
                    .unwrap(),
                vec![AccountMeta::new(account_metas_pda_key, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;

    let account_metas: Vec<SerializableAccountMeta> =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(
            account_metas_return_data.as_slice(),
        )
        .unwrap()
        .return_data;
    let account_metas: Vec<AccountMeta> = account_metas
        .into_iter()
        .map(|serializable_account_meta| serializable_account_meta.into())
        .collect();

    // Now let it rip with MultisigIsmInstruction::ValidatorsAndThreshold
    let validators_and_threshold_bytes = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &MultisigIsmInstruction::ValidatorsAndThreshold(test_message.to_vec())
                    .encode()
                    .unwrap(),
                account_metas,
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    assert_eq!(
        SimulationReturnData::<ValidatorsAndThreshold>::try_from_slice(
            validators_and_threshold_bytes.as_slice()
        )
        .unwrap()
        .return_data,
        validators_and_threshold
    );
}

#[tokio::test]
async fn test_ism_verify() {
    let program_id = multisig_ism_message_id_id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, _) =
        initialize(program_id, &mut banks_client, &payer, recent_blockhash)
            .await
            .unwrap();

    let MultisigIsmTestData {
        message,
        checkpoint,
        validators,
        signatures,
    } = get_multisig_ism_test_data();

    let origin_domain = message.origin;
    let validators_and_threshold = ValidatorsAndThreshold {
        validators: validators.clone(),
        threshold: 2,
    };

    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        origin_domain,
        validators_and_threshold.clone(),
    )
    .await
    .unwrap();

    // A valid verify instruction with a quorum
    let verify_instruction = VerifyInstruction {
        metadata: MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.root,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
            ],
        }
        .to_vec(),
        message: message.to_vec(),
    };

    // First get the account metas needed
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &program_id);
    let account_metas_return_data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &InterchainSecurityModuleInstruction::VerifyAccountMetas(
                    verify_instruction.clone(),
                )
                .encode()
                .unwrap(),
                vec![AccountMeta::new(account_metas_pda_key, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let account_metas: Vec<SerializableAccountMeta> =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(
            account_metas_return_data.as_slice(),
        )
        .unwrap()
        .return_data;
    let account_metas: Vec<AccountMeta> = account_metas
        .into_iter()
        .map(|serializable_account_meta| serializable_account_meta.into())
        .collect();

    // Now let it rip with MultisigIsmInstruction::ValidatorsAndThreshold
    let verify_simulation_logs = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &InterchainSecurityModuleInstruction::Verify(verify_instruction)
                    .encode()
                    .unwrap(),
                account_metas,
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .logs;
    // The only real indication of success in the interface we're given is the final log
    // indicating success
    assert_eq!(
        verify_simulation_logs[verify_simulation_logs.len() - 1],
        format!("Program {} success", program_id),
    );
}

#[tokio::test]
async fn test_ism_type() {
    let program_id = multisig_ism_message_id_id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let type_bytes = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &InterchainSecurityModuleInstruction::Type.encode().unwrap(),
                vec![],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let type_u32 = SimulationReturnData::<u32>::try_from_slice(type_bytes.as_slice())
        .unwrap()
        .return_data;
    assert_eq!(type_u32, ModuleType::MessageIdMultisig as u32);
}
