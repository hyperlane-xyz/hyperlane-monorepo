use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle as MerkleTree, Encode, HyperlaneMessage, H256,
};

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    message::Message,
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Inbox, InboxAccount, Outbox, OutboxAccount,
        ProcessedMessage, ProcessedMessageAccount,
    },
    error::Error as MailboxError,
    instruction::{InboxProcess, Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
    processor::process_instruction,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction, HANDLE_ACCOUNT_METAS_PDA_SEEDS,
    INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_test_ism::{test_ism_storage_pda_seeds, TestIsmError, TestIsmInstruction};
use hyperlane_sealevel_test_send_receiver::{
    test_send_receiver_storage_pda_seeds, IsmReturnDataMode, TestSendReceiverError,
    TestSendReceiverInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

use hyperlane_test_utils::{assert_transaction_error, initialize_mailbox, MailboxAccounts};

const LOCAL_DOMAIN: u32 = 13775;
const REMOTE_DOMAIN: u32 = 69420;

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_mailbox::id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_mailbox",
        program_id,
        processor!(process_instruction),
    );

    program_test.add_program("spl_noop", spl_noop::id(), processor!(spl_noop::noop));

    let mailbox_program_id = hyperlane_sealevel_mailbox::id();
    program_test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    // This serves as the default ISM on the Mailbox
    // TODO remove this in favor of test-ism here and everywhere else
    program_test.add_program(
        "hyperlane_sealevel_ism_rubber_stamp",
        hyperlane_sealevel_ism_rubber_stamp::id(),
        processor!(hyperlane_sealevel_ism_rubber_stamp::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_test_send_receiver",
        hyperlane_sealevel_test_send_receiver::id(),
        processor!(hyperlane_sealevel_test_send_receiver::process_instruction),
    );

    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    init_test_ism(&mut banks_client, &payer).await;

    init_test_send_receiver(&mut banks_client, &payer).await;
    set_test_send_receiver_ism(
        &mut banks_client,
        &payer,
        Some(hyperlane_sealevel_test_ism::id()),
        IsmReturnDataMode::EncodeOption,
    )
    .await;

    (banks_client, payer)
}

async fn init_test_send_receiver(banks_client: &mut BanksClient, payer: &Keypair) {
    let program_id = hyperlane_sealevel_test_send_receiver::id();

    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);

    let instruction = Instruction {
        program_id,
        data: TestSendReceiverInstruction::Init.try_to_vec().unwrap(),
        accounts: vec![
            // 0. [executable] System program.
            // 1. [signer] Payer.
            // 2. [writeable] Storage PDA.
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(storage_pda_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn set_test_send_receiver_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    ism: Option<Pubkey>,
    ism_return_data_mode: IsmReturnDataMode,
) {
    let program_id = hyperlane_sealevel_test_send_receiver::id();

    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);

    let instruction = Instruction {
        program_id,
        data: TestSendReceiverInstruction::SetInterchainSecurityModule(ism, ism_return_data_mode)
            .try_to_vec()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] Storage PDA.
            AccountMeta::new(storage_pda_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn set_test_send_receiver_fail_handle(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    fail_handle: bool,
) {
    let program_id = hyperlane_sealevel_test_send_receiver::id();

    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);

    let instruction = Instruction {
        program_id,
        data: TestSendReceiverInstruction::SetFailHandle(fail_handle)
            .try_to_vec()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] Storage PDA.
            AccountMeta::new(storage_pda_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn init_test_ism(banks_client: &mut BanksClient, payer: &Keypair) {
    let program_id = hyperlane_sealevel_test_ism::id();

    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_ism_storage_pda_seeds!(), &program_id);

    let instruction = Instruction {
        program_id,
        data: TestIsmInstruction::Init.try_to_vec().unwrap(),
        accounts: vec![
            // 0. [executable] System program.
            // 1. [signer] Payer.
            // 2. [writeable] Storage PDA.
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(storage_pda_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn set_test_ism_accept(banks_client: &mut BanksClient, payer: &Keypair, accept: bool) {
    let program_id = hyperlane_sealevel_test_ism::id();

    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_ism_storage_pda_seeds!(), &program_id);

    let instruction = Instruction {
        program_id,
        data: TestIsmInstruction::SetAccept(accept).try_to_vec().unwrap(),
        accounts: vec![
            // 0. [writeable] Storage PDA.
            AccountMeta::new(storage_pda_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    // Make sure the outbox account was created.
    assert_outbox(
        &mut banks_client,
        mailbox_accounts.outbox,
        Outbox {
            local_domain: LOCAL_DOMAIN,
            outbox_bump_seed: mailbox_accounts.outbox_bump_seed,
            owner: Some(payer.pubkey()),
            tree: MerkleTree::default(),
        },
    )
    .await;

    // Make sure the inbox account was created.
    let inbox_account = banks_client
        .get_account(mailbox_accounts.inbox)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(inbox_account.owner, program_id);

    let inbox = InboxAccount::fetch(&mut &inbox_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        *inbox,
        Inbox {
            local_domain: LOCAL_DOMAIN,
            inbox_bump_seed: mailbox_accounts.inbox_bump_seed,
            default_ism: hyperlane_sealevel_ism_rubber_stamp::id(),
            processed_count: 0,
        }
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    // Different local domain to force a different transaction signature,
    // otherwise we'll get a (silent) duplicate transaction error.
    let result = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN + 1).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

fn test_send_receiver_dispatch_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), &program_id)
}

async fn dispatch_from_test_send_receiver(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    outbox_dispatch: OutboxDispatch,
    program_id: Pubkey,
) -> Result<(Signature, Keypair, Pubkey), BanksClientError> {
    let unique_message_account_keypair = Keypair::new();

    let (dispatch_authority_key, _expected_dispatch_authority_bump) =
        test_send_receiver_dispatch_authority(&program_id);

    let (dispatched_message_account_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_accounts.program,
    );

    let instruction = Instruction {
        program_id,
        data: TestSendReceiverInstruction::Dispatch(outbox_dispatch)
            .try_to_vec()
            .unwrap(),
        accounts: vec![
            // 0. [executable] The Mailbox program.
            // And now the accounts expected by the Mailbox's OutboxDispatch instruction:
            // 2. [writeable] Outbox PDA.
            // 3. [] This program's dispatch authority.
            // 4. [executable] System program.
            // 5. [executable] SPL Noop program.
            // 6. [signer] Payer.
            // 7. [signer] Unique message account.
            // 8. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
            //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
            AccountMeta::new_readonly(mailbox_accounts.program, false),
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new_readonly(dispatch_authority_key, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_noop::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(unique_message_account_keypair.pubkey(), true),
            AccountMeta::new(dispatched_message_account_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];

    banks_client.process_transaction(transaction).await?;

    Ok((
        tx_signature,
        unique_message_account_keypair,
        dispatched_message_account_key,
    ))
}

async fn dispatch_from_payer(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    outbox_dispatch: OutboxDispatch,
) -> Result<(Signature, Keypair, Pubkey), BanksClientError> {
    let unique_message_account_keypair = Keypair::new();

    let (dispatched_message_account_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_accounts.program,
    );

    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::OutboxDispatch(outbox_dispatch)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] Outbox PDA.
            // 1. [signer] Message sender signer.
            // 2. [executable] System program.
            // 3. [executable] SPL Noop program.
            // 4. [signer] Payer.
            // 5. [signer] Unique message account.
            // 6. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
            //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_noop::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(unique_message_account_keypair.pubkey(), true),
            AccountMeta::new(dispatched_message_account_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await?;

    Ok((
        tx_signature,
        unique_message_account_keypair,
        dispatched_message_account_key,
    ))
}

async fn assert_dispatched_message(
    banks_client: &mut BanksClient,
    dispatch_tx_signature: Signature,
    dispatch_unique_account_pubkey: Pubkey,
    dispatched_message_account_key: Pubkey,
    expected_message: &HyperlaneMessage,
) {
    // Get the slot of the tx
    let dispatch_tx_status = banks_client
        .get_transaction_status(dispatch_tx_signature)
        .await
        .unwrap()
        .unwrap();
    let dispatch_slot = dispatch_tx_status.slot;

    // Get the dispatched message account
    let dispatched_message_account = banks_client
        .get_account(dispatched_message_account_key)
        .await
        .unwrap()
        .unwrap();
    let dispatched_message =
        DispatchedMessageAccount::fetch(&mut &dispatched_message_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        *dispatched_message,
        DispatchedMessage::new(
            expected_message.nonce,
            dispatch_slot,
            dispatch_unique_account_pubkey,
            expected_message.to_vec(),
        ),
    );
}

async fn assert_outbox(
    banks_client: &mut BanksClient,
    outbox_pubkey: Pubkey,
    expected_outbox: Outbox,
) {
    // Check that the outbox account was updated.
    let outbox_account = banks_client
        .get_account(outbox_pubkey)
        .await
        .unwrap()
        .unwrap();

    let outbox = OutboxAccount::fetch(&mut &outbox_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(*outbox, expected_outbox,);
}

#[tokio::test]
async fn test_dispatch_from_eoa() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient = H256::random();
    let message_body = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let outbox_dispatch = OutboxDispatch {
        sender: payer.pubkey(),
        destination_domain: REMOTE_DOMAIN,
        recipient,
        message_body: message_body.clone(),
    };

    let (dispatch_tx_signature, dispatch_unique_keypair, dispatched_message_account_key) =
        dispatch_from_payer(
            &mut banks_client,
            &payer,
            &mailbox_accounts,
            outbox_dispatch,
        )
        .await
        .unwrap();

    let expected_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: recipient,
        body: message_body,
    };

    assert_dispatched_message(
        &mut banks_client,
        dispatch_tx_signature,
        dispatch_unique_keypair.pubkey(),
        dispatched_message_account_key,
        &expected_message,
    )
    .await;

    let mut expected_tree = MerkleTree::default();
    expected_tree.ingest(expected_message.id());

    // Make sure the outbox account was updated.
    assert_outbox(
        &mut banks_client,
        mailbox_accounts.outbox,
        Outbox {
            local_domain: LOCAL_DOMAIN,
            outbox_bump_seed: mailbox_accounts.outbox_bump_seed,
            owner: Some(payer.pubkey()),
            tree: expected_tree,
        },
    )
    .await;

    // Dispatch another so we can make sure the nonce is incremented correctly
    let recipient = H256::random();
    let message_body = vec![69, 42, 0];
    let outbox_dispatch = OutboxDispatch {
        sender: payer.pubkey(),
        destination_domain: REMOTE_DOMAIN,
        recipient,
        message_body: message_body.clone(),
    };

    let (dispatch_tx_signature, dispatch_unique_keypair, dispatched_message_account_key) =
        dispatch_from_payer(
            &mut banks_client,
            &payer,
            &mailbox_accounts,
            outbox_dispatch,
        )
        .await
        .unwrap();

    let expected_message = HyperlaneMessage {
        version: 0,
        nonce: 1,
        origin: LOCAL_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: recipient,
        body: message_body,
    };

    assert_dispatched_message(
        &mut banks_client,
        dispatch_tx_signature,
        dispatch_unique_keypair.pubkey(),
        dispatched_message_account_key,
        &expected_message,
    )
    .await;

    expected_tree.ingest(expected_message.id());

    // Make sure the outbox account was updated.
    assert_outbox(
        &mut banks_client,
        mailbox_accounts.outbox,
        Outbox {
            local_domain: LOCAL_DOMAIN,
            outbox_bump_seed: mailbox_accounts.outbox_bump_seed,
            owner: Some(payer.pubkey()),
            tree: expected_tree,
        },
    )
    .await;
}

#[tokio::test]
async fn test_dispatch_from_program() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let test_sender_receiver_program_id = hyperlane_sealevel_test_send_receiver::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient = H256::random();
    let message_body = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    let outbox_dispatch = OutboxDispatch {
        // Set the sender to the sending program ID
        sender: test_sender_receiver_program_id,
        destination_domain: REMOTE_DOMAIN,
        recipient,
        message_body: message_body.clone(),
    };

    let (dispatch_tx_signature, dispatch_unique_keypair, dispatched_message_account_key) =
        dispatch_from_test_send_receiver(
            &mut banks_client,
            &payer,
            &mailbox_accounts,
            outbox_dispatch,
            test_sender_receiver_program_id,
        )
        .await
        .unwrap();

    let expected_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        // The sender should be the program ID because its dispatch authority signed
        sender: test_sender_receiver_program_id.to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: recipient,
        body: message_body,
    };

    assert_dispatched_message(
        &mut banks_client,
        dispatch_tx_signature,
        dispatch_unique_keypair.pubkey(),
        dispatched_message_account_key,
        &expected_message,
    )
    .await;

    let mut expected_tree = MerkleTree::default();
    expected_tree.ingest(expected_message.id());

    // Make sure the outbox account was updated.
    assert_outbox(
        &mut banks_client,
        mailbox_accounts.outbox,
        Outbox {
            local_domain: LOCAL_DOMAIN,
            outbox_bump_seed: mailbox_accounts.outbox_bump_seed,
            owner: Some(payer.pubkey()),
            tree: expected_tree,
        },
    )
    .await;
}

#[tokio::test]
async fn test_dispatch_errors_if_message_too_large() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient = H256::random();
    let message_body = vec![1; 2049];
    let outbox_dispatch = OutboxDispatch {
        sender: payer.pubkey(),
        destination_domain: REMOTE_DOMAIN,
        recipient,
        message_body,
    };

    let result = dispatch_from_payer(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        outbox_dispatch,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(MailboxError::MaxMessageSizeExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_dispatch_returns_message_id() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient = H256::random();
    let message_body = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let outbox_dispatch = OutboxDispatch {
        sender: payer.pubkey(),
        destination_domain: REMOTE_DOMAIN,
        recipient,
        message_body: message_body.clone(),
    };
    let expected_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: recipient,
        body: message_body,
    };

    let unique_message_account_keypair = Keypair::new();

    let (dispatched_message_account_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_accounts.program,
    );

    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::OutboxDispatch(outbox_dispatch)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] Outbox PDA.
            // 1. [signer] Message sender signer.
            // 2. [executable] System program.
            // 3. [executable] SPL Noop program.
            // 4. [signer] Payer.
            // 5. [signer] Unique message account.
            // 6. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
            //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_noop::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(unique_message_account_keypair.pubkey(), true),
            AccountMeta::new(dispatched_message_account_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation_data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
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

    let message_id = H256::try_from_slice(&simulation_data).unwrap();
    assert_eq!(message_id, expected_message.id());
}

/// Simulates an instruction, and attempts to deserialize it into a T.
/// If no return data at all was returned, returns Ok(None).
/// If some return data was returned but deserialization was unsuccesful,
/// an Err is returned.
async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> Result<Option<T>, BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await?;
    // If the result is an err, return an err
    if let Some(Err(err)) = simulation.result {
        return Err(BanksClientError::TransactionError(err));
    }
    let decoded_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .map(|return_data| T::try_from_slice(return_data.data.as_slice()).unwrap());

    Ok(decoded_data)
}

/// Simulates an Instruction that will return a list of AccountMetas.
pub async fn get_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    // If there's no data at all, default to an empty vec.
    let account_metas = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        banks_client,
        payer,
        instruction,
    )
    .await?
    .map(|serializable_account_metas| {
        serializable_account_metas
            .return_data
            .into_iter()
            .map(|serializable_account_meta| serializable_account_meta.into())
            .collect()
    })
    .unwrap_or_else(|| vec![]);

    Ok(account_metas)
}

/// Gets the recipient ISM given a recipient program id and the ISM getter account metas.
pub async fn get_recipient_ism_with_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    recipient_program_id: Pubkey,
    ism_getter_account_metas: Vec<AccountMeta>,
) -> Result<Pubkey, BanksClientError> {
    let mut accounts = vec![
        // Inbox PDA
        AccountMeta::new_readonly(mailbox_accounts.inbox, false),
        // The recipient program.
        AccountMeta::new_readonly(recipient_program_id, false),
    ];
    accounts.extend(ism_getter_account_metas);

    let instruction = Instruction::new_with_borsh(
        mailbox_accounts.program,
        &MailboxInstruction::InboxGetRecipientIsm(recipient_program_id),
        accounts,
    );
    let ism =
        simulate_instruction::<SimulationReturnData<Pubkey>>(banks_client, payer, instruction)
            .await?
            .unwrap()
            .return_data;
    Ok(ism)
}

/// Gets the account metas required for the recipient's
/// `MessageRecipientInstruction::InterchainSecurityModule` instruction.
pub async fn get_ism_getter_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recipient_program_id: Pubkey,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let (account_metas_pda_key, _) = Pubkey::find_program_address(
        INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
        &recipient_program_id,
    );
    let instruction = MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;
    let instruction = Instruction::new_with_bytes(
        recipient_program_id,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

async fn get_recipient_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    recipient: Pubkey,
) -> Result<Pubkey, BanksClientError> {
    let account_metas = get_ism_getter_account_metas(banks_client, &payer, recipient).await?;

    get_recipient_ism_with_account_metas(
        banks_client,
        &payer,
        &mailbox_accounts,
        recipient,
        account_metas,
    )
    .await
}

/// Gets the account metas required for the ISM's `Verify` instruction.
async fn get_ism_verify_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    ism: Pubkey,
    metadata: Vec<u8>,
    message: Vec<u8>,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &ism);
    let instruction = InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
        metadata,
        message,
    });
    let instruction = Instruction::new_with_bytes(
        ism,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

/// Gets the account metas required for the recipient's `MessageRecipientInstruction::Handle` instruction.
async fn get_handle_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    message: &HyperlaneMessage,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
    let instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction {
        sender: message.sender,
        origin: message.origin,
        message: message.body.clone(),
    });
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(HANDLE_ACCOUNT_METAS_PDA_SEEDS, &recipient_program_id);
    let instruction = Instruction::new_with_bytes(
        recipient_program_id,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

async fn process(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    metadata: Vec<u8>,
    message: &HyperlaneMessage,
) -> Result<(Signature, Pubkey), BanksClientError> {
    let recipient: Pubkey = message.recipient.0.into();
    let mut encoded_message = vec![];
    message.write_to(&mut encoded_message).unwrap();

    let mut instructions = Vec::with_capacity(1);

    let (process_authority_key, _process_authority_bump) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(&recipient),
        &mailbox_accounts.program,
    );
    let (processed_message_account_key, _processed_message_account_bump) =
        Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(message.id()),
            &mailbox_accounts.program,
        );

    // Get the account metas required for the recipient.InterchainSecurityModule instruction.
    let ism_getter_account_metas =
        get_ism_getter_account_metas(banks_client, payer, recipient).await?;

    // Get the recipient ISM.
    let ism = get_recipient_ism_with_account_metas(
        banks_client,
        payer,
        mailbox_accounts,
        recipient,
        ism_getter_account_metas.clone(),
    )
    .await?;

    let ixn = MailboxInstruction::InboxProcess(InboxProcess {
        metadata: metadata.to_vec(),
        message: encoded_message.clone(),
    });
    let ixn_data = ixn.into_instruction_data().unwrap();

    // Craft the accounts for the transaction.
    let mut accounts: Vec<AccountMeta> = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(mailbox_accounts.inbox, false),
        AccountMeta::new_readonly(process_authority_key, false),
        AccountMeta::new(processed_message_account_key, false),
    ];
    accounts.extend(ism_getter_account_metas);
    accounts.extend([
        AccountMeta::new_readonly(spl_noop::id(), false),
        AccountMeta::new_readonly(ism, false),
    ]);

    // Get the account metas required for the ISM.Verify instruction.
    let ism_verify_account_metas =
        get_ism_verify_account_metas(banks_client, payer, ism, metadata.into(), encoded_message)
            .await?;
    accounts.extend(ism_verify_account_metas);

    // The recipient.
    accounts.extend([AccountMeta::new_readonly(recipient, false)]);

    // Get account metas required for the Handle instruction
    let handle_account_metas = get_handle_account_metas(banks_client, payer, message).await?;
    accounts.extend(handle_account_metas);

    let inbox_instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: ixn_data,
        accounts,
    };
    instructions.push(inbox_instruction);
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let txn = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    let tx_signature = txn.signatures[0];

    banks_client.process_transaction(txn).await?;

    Ok((tx_signature, processed_message_account_key))
}

#[tokio::test]
async fn test_get_recipient_ism_when_specified() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let ism = Some(Pubkey::new_unique());

    set_test_send_receiver_ism(
        &mut banks_client,
        &payer,
        ism,
        IsmReturnDataMode::EncodeOption,
    )
    .await;

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    assert_eq!(recipient_ism, ism.unwrap());
}

#[tokio::test]
async fn test_get_recipient_ism_when_option_none_returned() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let ism = None;

    set_test_send_receiver_ism(
        &mut banks_client,
        &payer,
        ism,
        IsmReturnDataMode::EncodeOption,
    )
    .await;

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    // Expect the default ISM to be used
    assert_eq!(recipient_ism, mailbox_accounts.default_ism);
}

#[tokio::test]
async fn test_get_recipient_ism_when_no_return_data() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let ism = None;

    set_test_send_receiver_ism(
        &mut banks_client,
        &payer,
        ism,
        // Return nothing!
        IsmReturnDataMode::ReturnNothing,
    )
    .await;

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    // Expect the default ISM to be used
    assert_eq!(recipient_ism, mailbox_accounts.default_ism);
}

#[tokio::test]
async fn test_get_recipient_ism_errors_with_malformmated_recipient_ism_return_data() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let ism = None;

    set_test_send_receiver_ism(
        &mut banks_client,
        &payer,
        ism,
        // Return some malformmated data
        IsmReturnDataMode::ReturnMalformmatedData,
    )
    .await;

    let result =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id).await;
    // Expect a BorshIoError
    assert!(matches!(
        result,
        Err(BanksClientError::TransactionError(
            TransactionError::InstructionError(_, InstructionError::BorshIoError(_))
        ))
    ));
}

async fn assert_processed_message(
    banks_client: &mut BanksClient,
    process_tx_signature: Signature,
    processed_message_account_key: Pubkey,
    expected_message: &HyperlaneMessage,
    expected_sequence: u64,
) {
    println!("process_tx_signature {}", process_tx_signature);
    // Get the slot of the tx
    let process_tx_status = banks_client
        .get_transaction_status(process_tx_signature)
        .await
        .unwrap()
        .unwrap();
    let process_slot = process_tx_status.slot;

    // Get the processed message account
    let processed_message_account = banks_client
        .get_account(processed_message_account_key)
        .await
        .unwrap()
        .unwrap();
    let processed_message =
        ProcessedMessageAccount::fetch(&mut &processed_message_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        *processed_message,
        ProcessedMessage::new(expected_sequence, expected_message.id(), process_slot,),
    );
}

async fn assert_message_not_processed(
    banks_client: &mut BanksClient,
    mailbox_accounts: &MailboxAccounts,
    message_id: H256,
) {
    let (processed_message_account_key, _processed_message_account_bump) =
        Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(&message_id),
            &mailbox_accounts.program,
        );

    // Get the processed message account
    let processed_message_account = banks_client
        .get_account(processed_message_account_key)
        .await
        .unwrap();
    assert!(processed_message_account.is_none());
}

#[tokio::test]
async fn test_process_successful_verify_and_handle() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let (process_tx_signature, processed_message_account_key) = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await
    .unwrap();

    // Expect the message's processed account to be created
    assert_processed_message(
        &mut banks_client,
        process_tx_signature,
        processed_message_account_key,
        &message,
        0,
    )
    .await;

    // Send another to illustrate that the sequence is incremented
    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![42, 0, 69],
    };

    let (process_tx_signature, processed_message_account_key) = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await
    .unwrap();

    // Expect the message's processed account to be created
    assert_processed_message(
        &mut banks_client,
        process_tx_signature,
        processed_message_account_key,
        &message,
        1,
    )
    .await;
}

#[tokio::test]
async fn test_process_errors_if_message_already_processed() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let (process_tx_signature, processed_message_account_key) = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await
    .unwrap();

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(MailboxError::MessageAlreadyProcessed as u32),
        ),
    )
}

#[tokio::test]
async fn test_process_errors_if_ism_verify_fails() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    set_test_ism_accept(&mut banks_client, &payer, false).await;

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(TestIsmError::VerifyNotAccepted as u32),
        ),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_process_errors_if_recipient_handle_fails() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    set_test_send_receiver_fail_handle(&mut banks_client, &payer, true).await;

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(TestSendReceiverError::HandleFailed as u32),
        ),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_process_errors_if_incorrect_destination_domain() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        // Incorrect destination domain
        destination: LOCAL_DOMAIN + 1,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(MailboxError::IncorrectDestinationDomain as u32),
        ),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_process_errors_if_wrong_message_version() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let message = HyperlaneMessage {
        version: 1,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: recipient_id.to_bytes().into(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(MailboxError::UnsupportedMessageVersion as u32),
        ),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_process_errors_if_recipient_not_a_program() {
    let program_id = hyperlane_sealevel_mailbox::id();
    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    let message = HyperlaneMessage {
        version: 1,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: payer.pubkey().to_bytes().into(),
        destination: LOCAL_DOMAIN,
        recipient: H256::random(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    };

    let result = process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await;

    assert_transaction_error(result, TransactionError::ProgramAccountNotFound);

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}
