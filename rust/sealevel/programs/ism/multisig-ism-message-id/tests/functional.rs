//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use borsh::BorshDeserialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

use hyperlane_core::{Encode, HyperlaneMessage, IsmType, H160, H256};
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds,
    accounts::{AccessControlAccount, AccessControlData, DomainData, DomainDataAccount},
    domain_data_pda_seeds,
    error::Error as MultisigIsmError,
    instruction::{Domained, Instruction as MultisigIsmProgramInstruction, ValidatorsAndThreshold},
    processor::process_instruction,
};
use multisig_ism::interface::MultisigIsmInstruction;
use solana_program_test::*;
use solana_sdk::{
    hash::Hash,
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            &keypair.pubkey(),
            lamports,
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
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

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_borsh(
            program_id,
            &MultisigIsmProgramInstruction::Initialize,
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(access_control_pda_key, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await?;

    Ok((access_control_pda_key, _access_control_pda_bump_seed))
}

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_multisig_ism_message_id::id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, access_control_pda_bump_seed) = initialize(
        program_id.clone(),
        &mut banks_client,
        &payer,
        recent_blockhash.clone(),
    )
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
            owner: payer.pubkey(),
        }),
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = hyperlane_sealevel_multisig_ism_message_id::id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    initialize(
        program_id.clone(),
        &mut banks_client,
        &payer,
        recent_blockhash.clone(),
    )
    .await
    .unwrap();

    // Create a new payer as a hack to get a new tx ID, because the
    // instruction data is the same and the recent blockhash is the same
    let new_payer = new_funded_keypair(&mut banks_client, &payer, 1000000).await;
    let result = initialize(
        program_id.clone(),
        &mut banks_client,
        &new_payer,
        recent_blockhash,
    )
    .await;

    // BanksClientError doesn't implement Eq, but TransactionError does
    if let BanksClientError::TransactionError(tx_err) = result.err().unwrap() {
        assert_eq!(
            tx_err,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(MultisigIsmError::AlreadyInitialized as u32)
            )
        );
    } else {
        panic!("expected TransactionError");
    }
}

#[tokio::test]
async fn test_set_validators_and_threshold_creates_pda_account() {
    let program_id = hyperlane_sealevel_multisig_ism_message_id::id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, _) = initialize(
        program_id.clone(),
        &mut banks_client,
        &payer,
        recent_blockhash.clone(),
    )
    .await
    .unwrap();

    let domain: u32 = 1234;

    let (domain_data_pda_key, domain_data_pda_bump_seed) =
        Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

    let validators_and_threshold = ValidatorsAndThreshold {
        validators: vec![H160::random(), H160::random(), H160::random()],
        threshold: 2,
    };

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_borsh(
            program_id,
            &MultisigIsmProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain,
                data: validators_and_threshold.clone(),
            }),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[&payer], recent_blockhash);
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

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_borsh(
            program_id,
            &MultisigIsmProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain,
                data: validators_and_threshold.clone(),
            }),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[&payer], recent_blockhash);
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

    // For good measure, let's also use the MultisigIsmProgramInstruction::ValidatorsAndThreshold
    // instruction!

    let test_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: domain,
        sender: H256::random(),
        destination: domain + 1,
        recipient: H256::random(),
        body: vec![1, 2, 3, 4, 5],
    };

    let validators_and_threshold_bytes = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &MultisigIsmInstruction::ValidatorsAndThreshold(test_message.to_vec())
                    .encode()
                    .unwrap(),
                vec![AccountMeta::new(domain_data_pda_key, false)],
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
        ValidatorsAndThreshold::try_from_slice(validators_and_threshold_bytes.as_slice()).unwrap(),
        validators_and_threshold
    );
}

#[tokio::test]
async fn test_ism_type() {
    let program_id = hyperlane_sealevel_multisig_ism_message_id::id();
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
    assert_eq!(type_bytes[0] as u32, IsmType::MessageIdMultisig as u32);
}
