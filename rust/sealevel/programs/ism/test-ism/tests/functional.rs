//! Functional tests for the test ISM: every instruction, its account checks,
//! storage layout, return data and error codes.
//!
//! Runs natively by default; with `SBF_OUT_DIR` set, solana-program-test loads
//! `hyperlane_sealevel_test_ism.so` from that directory instead, so the same
//! suite checks any compiled implementation of the program.

// The runtime still reports InstructionError::NotEnoughAccountKeys.
#![allow(deprecated)]

use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VerifyMetadataSpecInstruction,
};
use hyperlane_sealevel_test_ism::{
    id,
    program::{TestIsmError, TestIsmInstruction},
    test_ism_storage_pda_seeds,
};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    rent::Rent,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

fn storage_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(test_ism_storage_pda_seeds!(), &id())
}

fn program_test() -> ProgramTest {
    ProgramTest::new(
        "hyperlane_sealevel_test_ism",
        id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    )
}

async fn start(program_test: ProgramTest) -> (BanksClient, Keypair) {
    let (banks_client, payer, _) = program_test.start().await;
    (banks_client, payer)
}

fn init_instruction(payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        data: borsh::to_vec(&TestIsmInstruction::Init).unwrap(),
        accounts: vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new(storage_pda().0, false),
        ],
    }
}

fn set_accept_instruction(storage: Pubkey, accept: bool) -> Instruction {
    Instruction {
        program_id: id(),
        data: borsh::to_vec(&TestIsmInstruction::SetAccept(accept)).unwrap(),
        accounts: vec![AccountMeta::new(storage, false)],
    }
}

fn verify_instruction(accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: id(),
        data: InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(
            vec![1, 2, 3],
            vec![4, 5, 6, 7],
        ))
        .encode()
        .unwrap(),
        accounts,
    }
}

fn raw_instruction(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: id(),
        data,
        accounts,
    }
}

async fn send(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await
}

fn assert_instruction_error(result: Result<(), BanksClientError>, expected: InstructionError) {
    match result {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(0, err))) => {
            assert_eq!(err, expected)
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

/// Simulates the instruction and returns its result and return data.
async fn simulate(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> (Result<(), TransactionError>, Option<Vec<u8>>) {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();
    let return_data = simulation
        .simulation_details
        .and_then(|details| details.return_data)
        .map(|data| data.data);
    (simulation.result.unwrap(), return_data)
}

/// Moves to a new blockhash so an identical transaction is not deduplicated.
async fn refresh_blockhash(banks_client: &mut BanksClient) {
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .get_new_latest_blockhash(&blockhash)
        .await
        .unwrap();
}

async fn get_account(banks_client: &mut BanksClient, key: Pubkey) -> Option<Account> {
    banks_client.get_account(key).await.unwrap()
}

#[tokio::test]
async fn test_init_creates_storage() {
    let (mut banks_client, payer) = start(program_test()).await;

    send(
        &mut banks_client,
        &payer,
        init_instruction(&payer.pubkey()),
        &[],
    )
    .await
    .unwrap();

    let storage = get_account(&mut banks_client, storage_pda().0)
        .await
        .unwrap();
    assert_eq!(storage.owner, id());
    // AccountData<TestIsmStorage { accept: true }>: initialized flag, then accept.
    assert_eq!(storage.data, vec![1, 1]);
    assert_eq!(storage.lamports, Rent::default().minimum_balance(2));
}

#[tokio::test]
async fn test_init_prefunded_storage() {
    let (mut banks_client, payer) = start(program_test()).await;
    let storage = storage_pda().0;

    // Fund the PDA first: init must top up, allocate and assign instead of
    // create_account.
    send(
        &mut banks_client,
        &payer,
        system_instruction::transfer(
            &payer.pubkey(),
            &storage,
            Rent::default().minimum_balance(0),
        ),
        &[],
    )
    .await
    .unwrap();

    send(
        &mut banks_client,
        &payer,
        init_instruction(&payer.pubkey()),
        &[],
    )
    .await
    .unwrap();

    let account = get_account(&mut banks_client, storage).await.unwrap();
    assert_eq!(account.owner, id());
    assert_eq!(account.data, vec![1, 1]);
    assert_eq!(account.lamports, Rent::default().minimum_balance(2));
}

#[tokio::test]
async fn test_init_errors_if_called_twice() {
    let (mut banks_client, payer) = start(program_test()).await;

    send(
        &mut banks_client,
        &payer,
        init_instruction(&payer.pubkey()),
        &[],
    )
    .await
    .unwrap();

    // The storage now has lamports, so init allocates; the System program
    // rejects the in-use account with SystemError::AccountAlreadyInUse.
    refresh_blockhash(&mut banks_client).await;
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            init_instruction(&payer.pubkey()),
            &[],
        )
        .await,
        InstructionError::Custom(0),
    );
}

#[tokio::test]
async fn test_init_account_errors() {
    let (mut banks_client, payer) = start(program_test()).await;
    let other = Keypair::new();

    // Wrong System program.
    let mut ix = init_instruction(&payer.pubkey());
    ix.accounts[0] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    assert_instruction_error(
        send(&mut banks_client, &payer, ix, &[]).await,
        InstructionError::InvalidArgument,
    );

    // Payer did not sign.
    let mut ix = init_instruction(&payer.pubkey());
    ix.accounts[1] = AccountMeta::new(other.pubkey(), false);
    assert_instruction_error(
        send(&mut banks_client, &payer, ix, &[]).await,
        InstructionError::MissingRequiredSignature,
    );

    // Not the storage PDA.
    let mut ix = init_instruction(&payer.pubkey());
    ix.accounts[2] = AccountMeta::new(Pubkey::new_unique(), false);
    assert_instruction_error(
        send(&mut banks_client, &payer, ix, &[]).await,
        InstructionError::InvalidArgument,
    );

    // Missing the storage account.
    let mut ix = init_instruction(&payer.pubkey());
    ix.accounts.truncate(2);
    assert_instruction_error(
        send(&mut banks_client, &payer, ix, &[]).await,
        InstructionError::NotEnoughAccountKeys,
    );

    // No accounts at all.
    let mut ix = init_instruction(&payer.pubkey());
    ix.accounts.clear();
    assert_instruction_error(
        send(&mut banks_client, &payer, ix, &[]).await,
        InstructionError::NotEnoughAccountKeys,
    );
}

#[tokio::test]
async fn test_set_accept_and_verify() {
    let (mut banks_client, payer) = start(program_test()).await;
    let storage = storage_pda().0;
    send(
        &mut banks_client,
        &payer,
        init_instruction(&payer.pubkey()),
        &[],
    )
    .await
    .unwrap();

    // Accepts after init.
    send(
        &mut banks_client,
        &payer,
        verify_instruction(vec![AccountMeta::new_readonly(storage, false)]),
        &[],
    )
    .await
    .unwrap();

    send(
        &mut banks_client,
        &payer,
        set_accept_instruction(storage, false),
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        get_account(&mut banks_client, storage).await.unwrap().data,
        vec![1, 0]
    );
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            verify_instruction(vec![AccountMeta::new_readonly(storage, false)]),
            &[],
        )
        .await,
        InstructionError::Custom(TestIsmError::VerifyNotAccepted as u32),
    );

    send(
        &mut banks_client,
        &payer,
        set_accept_instruction(storage, true),
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        get_account(&mut banks_client, storage).await.unwrap().data,
        vec![1, 1]
    );
    refresh_blockhash(&mut banks_client).await;
    send(
        &mut banks_client,
        &payer,
        verify_instruction(vec![AccountMeta::new_readonly(storage, false)]),
        &[],
    )
    .await
    .unwrap();
}

/// Adds a program-owned account with the given data and returns its key.
fn add_storage_like(program_test: &mut ProgramTest, data: Vec<u8>) -> Pubkey {
    let key = Pubkey::new_unique();
    program_test.add_account(
        key,
        Account {
            lamports: Rent::default().minimum_balance(data.len()).max(1),
            data,
            owner: id(),
            executable: false,
            rent_epoch: 0,
        },
    );
    key
}

#[tokio::test]
async fn test_verify_storage_states() {
    let mut program_test = program_test();
    let accepting = add_storage_like(&mut program_test, vec![1, 1]);
    let rejecting = add_storage_like(&mut program_test, vec![1, 0]);
    let uninitialized = add_storage_like(&mut program_test, vec![0, 1]);
    let bad_flag = add_storage_like(&mut program_test, vec![2, 1]);
    let bad_bool = add_storage_like(&mut program_test, vec![1, 2]);
    let truncated = add_storage_like(&mut program_test, vec![1]);
    let trailing = add_storage_like(&mut program_test, vec![1, 1, 9, 9]);
    let (mut banks_client, payer) = start(program_test).await;
    let missing = Pubkey::new_unique();

    let cases: Vec<(Pubkey, Option<InstructionError>)> = vec![
        (accepting, None),
        (trailing, None),
        (
            rejecting,
            Some(InstructionError::Custom(
                TestIsmError::VerifyNotAccepted as u32,
            )),
        ),
        (
            uninitialized,
            Some(InstructionError::Custom(
                TestIsmError::VerifyNotAccepted as u32,
            )),
        ),
        (
            missing,
            Some(InstructionError::Custom(
                TestIsmError::VerifyNotAccepted as u32,
            )),
        ),
        (bad_flag, Some(InstructionError::BorshIoError)),
        (bad_bool, Some(InstructionError::BorshIoError)),
        (truncated, Some(InstructionError::BorshIoError)),
    ];
    for (key, expected) in cases {
        let result = send(
            &mut banks_client,
            &payer,
            verify_instruction(vec![AccountMeta::new_readonly(key, false)]),
            &[],
        )
        .await;
        match expected {
            None => result.unwrap(),
            Some(err) => assert_instruction_error(result, err),
        }
    }

    assert_instruction_error(
        send(&mut banks_client, &payer, verify_instruction(vec![]), &[]).await,
        InstructionError::NotEnoughAccountKeys,
    );
}

#[tokio::test]
async fn test_set_accept_errors() {
    let mut program_test = program_test();
    let storage = add_storage_like(&mut program_test, vec![1, 1]);
    let empty = add_storage_like(&mut program_test, vec![]);
    let bad_flag = add_storage_like(&mut program_test, vec![3, 0]);
    let (mut banks_client, payer) = start(program_test).await;

    // Readonly storage cannot be stored.
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            raw_instruction(
                borsh::to_vec(&TestIsmInstruction::SetAccept(false)).unwrap(),
                vec![AccountMeta::new_readonly(storage, false)],
            ),
            &[],
        )
        .await,
        InstructionError::InvalidAccountData,
    );
    // Empty data decodes as default but has no room to store.
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            set_accept_instruction(empty, false),
            &[],
        )
        .await,
        InstructionError::BorshIoError,
    );
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            set_accept_instruction(bad_flag, false),
            &[],
        )
        .await,
        InstructionError::BorshIoError,
    );
    assert_instruction_error(
        send(
            &mut banks_client,
            &payer,
            raw_instruction(
                borsh::to_vec(&TestIsmInstruction::SetAccept(false)).unwrap(),
                vec![],
            ),
            &[],
        )
        .await,
        InstructionError::NotEnoughAccountKeys,
    );
}

#[tokio::test]
async fn test_invalid_instruction_data() {
    let (mut banks_client, payer) = start(program_test()).await;
    let storage = storage_pda().0;

    let verify =
        InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(vec![1], vec![2]))
            .encode()
            .unwrap();
    let mut verify_trailing = verify.clone();
    verify_trailing.push(0);

    let cases: Vec<Vec<u8>> = vec![
        vec![],
        vec![2],
        vec![0, 0],
        vec![1],
        vec![1, 2],
        vec![1, 1, 0],
        vec![9; 8],
        verify[..verify.len() - 1].to_vec(),
        verify_trailing,
    ];
    for data in cases {
        assert_instruction_error(
            send(
                &mut banks_client,
                &payer,
                raw_instruction(data, vec![AccountMeta::new(storage, false)]),
                &[],
            )
            .await,
            InstructionError::InvalidInstructionData,
        );
    }
}

#[tokio::test]
async fn test_type_return_data() {
    let (mut banks_client, payer) = start(program_test()).await;

    let type_ix = InterchainSecurityModuleInstruction::Type.encode().unwrap();
    let mut type_trailing = type_ix.clone();
    type_trailing.extend_from_slice(&[7, 7, 7]);

    for data in [type_ix, type_trailing] {
        let (result, return_data) =
            simulate(&mut banks_client, &payer, raw_instruction(data, vec![])).await;
        result.unwrap();
        // SimulationReturnData<u32>(ModuleType::Unused).
        assert_eq!(return_data, Some(vec![0, 0, 0, 0, 255]));
    }
}

#[tokio::test]
async fn test_verify_metadata_spec_return_data() {
    let (mut banks_client, payer) = start(program_test()).await;

    let data = InterchainSecurityModuleInstruction::VerifyMetadataSpec(
        VerifyMetadataSpecInstruction::new(vec![1, 2, 3]),
    )
    .encode()
    .unwrap();
    let (result, return_data) = simulate(
        &mut banks_client,
        &payer,
        raw_instruction(
            data,
            vec![AccountMeta::new_readonly(storage_pda().0, false)],
        ),
    )
    .await;
    result.unwrap();
    // SimulationReturnData<MetadataSpecResult { spec: Some(Null), accounts: [] }>.
    assert_eq!(return_data, Some(vec![1, 0, 0, 0, 0, 0, 255]));
}

#[tokio::test]
async fn test_verify_account_metas_return_data() {
    let (mut banks_client, payer) = start(program_test()).await;

    let data = InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction::new(
        vec![],
        vec![1, 2, 3],
    ))
    .encode()
    .unwrap();
    let (result, return_data) =
        simulate(&mut banks_client, &payer, raw_instruction(data, vec![])).await;
    result.unwrap();

    // SimulationReturnData<Vec<SerializableAccountMeta>>: the readonly,
    // non-signer storage PDA.
    let mut expected = vec![1, 0, 0, 0];
    expected.extend_from_slice(storage_pda().0.as_ref());
    expected.extend_from_slice(&[0, 0, 255]);
    assert_eq!(return_data, Some(expected));
}
