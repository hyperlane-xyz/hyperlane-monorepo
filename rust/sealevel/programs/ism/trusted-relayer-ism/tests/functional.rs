//! Functional tests for the trusted-relayer ISM program.
//!
//! Covers: initialize, double-init error, set_relayer (owner and non-owner),
//! verify (success, wrong relayer, relayer not signer), verify_account_metas,
//! and module type.

use borsh::BorshDeserialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use hyperlane_core::ModuleType;
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_trusted_relayer_ism::{
    accounts::StorageAccount,
    error::Error,
    instruction::{init_instruction, set_relayer_instruction, verify_account_metas_instruction},
    processor::process_instruction as ism_process_instruction,
};
use hyperlane_test_utils::{
    assert_transaction_error, new_funded_keypair, process_instruction as submit_instruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

fn program_id() -> Pubkey {
    Pubkey::new_from_array([
        0x54, 0x72, 0x75, 0x73, 0x74, 0x65, 0x64, 0x52, 0x65, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x49,
        0x53, 0x4d, 0x50, 0x72, 0x6f, 0x67, 0x72, 0x61, 0x6d, 0x54, 0x65, 0x73, 0x74, 0x31, 0x32,
        0x33, 0x34,
    ])
}

fn new_program_test() -> ProgramTest {
    ProgramTest::new(
        "hyperlane_sealevel_trusted_relayer_ism",
        program_id(),
        processor!(ism_process_instruction),
    )
}

fn storage_pda(program_id: Pubkey) -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &program_id).0
}

async fn initialize(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    relayer: Pubkey,
) -> Result<(), BanksClientError> {
    let ix = init_instruction(program_id(), payer.pubkey(), relayer).unwrap();
    submit_instruction(banks_client, ix, payer, &[payer]).await?;
    Ok(())
}

// ===== initialize =====

#[tokio::test]
async fn test_initialize() {
    let program_id = program_id();
    let (mut banks_client, payer, _) = new_program_test().start().await;
    let relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, relayer)
        .await
        .unwrap();

    let storage_pda = storage_pda(program_id);
    let data = banks_client
        .get_account(storage_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = StorageAccount::fetch_data(&mut &data[..]).unwrap().unwrap();

    assert_eq!(storage.owner, Some(payer.pubkey()));
    assert_eq!(storage.relayer, relayer);
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let (mut banks_client, payer, _) = new_program_test().start().await;
    let relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, relayer)
        .await
        .unwrap();

    // Use a different payer to get a distinct transaction ID.
    let new_payer = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;
    let result = initialize(&mut banks_client, &new_payer, relayer).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::AlreadyInitialized as u32),
        ),
    );
}

// ===== set_relayer =====

#[tokio::test]
async fn test_set_relayer() {
    let program_id = program_id();
    let (mut banks_client, payer, _) = new_program_test().start().await;
    let old_relayer = Keypair::new().pubkey();
    let new_relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, old_relayer)
        .await
        .unwrap();

    let ix = set_relayer_instruction(program_id, payer.pubkey(), new_relayer).unwrap();
    submit_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let storage_pda = storage_pda(program_id);
    let data = banks_client
        .get_account(storage_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = StorageAccount::fetch_data(&mut &data[..]).unwrap().unwrap();
    assert_eq!(storage.relayer, new_relayer);
}

#[tokio::test]
async fn test_set_relayer_errors_if_not_owner() {
    let program_id = program_id();
    let (mut banks_client, payer, _) = new_program_test().start().await;
    let relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, relayer)
        .await
        .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;
    let ix = set_relayer_instruction(program_id, non_owner.pubkey(), relayer).unwrap();
    let result = submit_instruction(&mut banks_client, ix, &non_owner, &[&non_owner]).await;

    // AccessControl returns NotOwner, which surfaces as MissingRequiredSignature
    assert!(result.is_err());
}

// ===== verify =====

#[tokio::test]
async fn test_verify_succeeds_for_trusted_relayer() {
    let program_id = program_id();
    let (mut banks_client, payer, recent_blockhash) = new_program_test().start().await;
    let relayer = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;

    initialize(&mut banks_client, &payer, relayer.pubkey())
        .await
        .unwrap();

    let storage_pda = storage_pda(program_id);
    let verify_ix = Instruction::new_with_bytes(
        program_id,
        &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
            metadata: vec![],
            message: vec![],
        })
        .encode()
        .unwrap(),
        vec![
            AccountMeta::new_readonly(storage_pda, false),
            AccountMeta::new_readonly(relayer.pubkey(), true),
        ],
    );

    let tx = Transaction::new_signed_with_payer(
        &[verify_ix],
        Some(&payer.pubkey()),
        &[&payer, &relayer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

#[tokio::test]
async fn test_verify_errors_for_wrong_relayer() {
    let program_id = program_id();
    let (mut banks_client, payer, recent_blockhash) = new_program_test().start().await;
    let trusted_relayer = Keypair::new().pubkey();
    let wrong_relayer = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;

    initialize(&mut banks_client, &payer, trusted_relayer)
        .await
        .unwrap();

    let storage_pda = storage_pda(program_id);
    let verify_ix = Instruction::new_with_bytes(
        program_id,
        &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
            metadata: vec![],
            message: vec![],
        })
        .encode()
        .unwrap(),
        vec![
            AccountMeta::new_readonly(storage_pda, false),
            AccountMeta::new_readonly(wrong_relayer.pubkey(), true),
        ],
    );

    let tx = Transaction::new_signed_with_payer(
        &[verify_ix],
        Some(&payer.pubkey()),
        &[&payer, &wrong_relayer],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(tx).await;

    assert_transaction_error(
        result.map(|_| ()),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::InvalidRelayer as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_errors_if_relayer_not_signer() {
    let program_id = program_id();
    let (mut banks_client, payer, recent_blockhash) = new_program_test().start().await;
    let relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, relayer)
        .await
        .unwrap();

    let storage_pda = storage_pda(program_id);
    // relayer is in accounts but is_signer = false
    let verify_ix = Instruction::new_with_bytes(
        program_id,
        &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
            metadata: vec![],
            message: vec![],
        })
        .encode()
        .unwrap(),
        vec![
            AccountMeta::new_readonly(storage_pda, false),
            AccountMeta::new_readonly(relayer, false),
        ],
    );

    let tx = Transaction::new_signed_with_payer(
        &[verify_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(tx).await;

    assert_transaction_error(
        result.map(|_| ()),
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RelayerNotSigner as u32),
        ),
    );
}

// ===== verify_account_metas =====

#[tokio::test]
async fn test_verify_account_metas_returns_storage_pda_and_relayer() {
    let program_id = program_id();
    let (mut banks_client, payer, recent_blockhash) = new_program_test().start().await;
    let relayer = Keypair::new().pubkey();

    initialize(&mut banks_client, &payer, relayer)
        .await
        .unwrap();

    let vam_ix = verify_account_metas_instruction(program_id, vec![], vec![]).unwrap();

    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[vam_ix],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert!(simulation.result.unwrap().is_ok());

    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let account_metas =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(&return_data)
            .unwrap()
            .return_data
            .into_iter()
            .map(AccountMeta::from)
            .collect::<Vec<_>>();

    let storage_pda = storage_pda(program_id);

    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda);
    assert!(!account_metas[0].is_signer);
    assert!(!account_metas[0].is_writable);
    assert_eq!(account_metas[1].pubkey, relayer);
    assert!(account_metas[1].is_signer);
    assert!(!account_metas[1].is_writable);
}

// ===== module type =====

#[tokio::test]
async fn test_ism_type() {
    let program_id = program_id();
    let (mut banks_client, payer, recent_blockhash) = new_program_test().start().await;

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
    assert_eq!(type_u32, ModuleType::Null as u32);
}
