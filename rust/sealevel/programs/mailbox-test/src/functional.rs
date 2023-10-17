use borsh::BorshDeserialize;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle as MerkleTree, HyperlaneMessage, H256,
};
use hyperlane_sealevel_mailbox::{
    accounts::{Inbox, InboxAccount, Outbox},
    error::Error as MailboxError,
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds,
};
use hyperlane_sealevel_test_ism::{program::TestIsmError, test_client::TestIsmTestClient};
use hyperlane_sealevel_test_send_receiver::{
    program::{HandleMode, IsmReturnDataMode, TestSendReceiverError},
    test_client::TestSendReceiverTestClient,
};
use hyperlane_test_utils::{
    assert_transaction_error, clone_keypair, get_process_account_metas, get_recipient_ism,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, process_instruction,
    process_with_accounts,
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
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use crate::utils::{
    assert_dispatched_message, assert_inbox, assert_message_not_processed, assert_outbox,
    assert_processed_message, dispatch_from_payer,
};

const LOCAL_DOMAIN: u32 = 13775;
const REMOTE_DOMAIN: u32 = 69420;

async fn setup_client() -> (
    BanksClient,
    Keypair,
    TestSendReceiverTestClient,
    TestIsmTestClient,
) {
    let program_id = mailbox_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_mailbox",
        program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    program_test.add_program("spl_noop", spl_noop::id(), processor!(spl_noop::noop));

    let mailbox_program_id = mailbox_id();
    program_test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_test_send_receiver",
        hyperlane_sealevel_test_send_receiver::id(),
        processor!(hyperlane_sealevel_test_send_receiver::program::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    let test_ism = TestIsmTestClient::new(banks_client.clone(), clone_keypair(&payer));

    let mut test_send_receiver =
        TestSendReceiverTestClient::new(banks_client.clone(), clone_keypair(&payer));
    test_send_receiver.init().await.unwrap();
    test_send_receiver
        .set_ism(
            Some(hyperlane_sealevel_test_ism::id()),
            IsmReturnDataMode::EncodeOption,
        )
        .await
        .unwrap();

    (banks_client, payer, test_send_receiver, test_ism)
}

#[tokio::test]
async fn test_initialize() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
            default_ism: hyperlane_sealevel_test_ism::id(),
            processed_count: 0,
        }
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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

#[tokio::test]
async fn test_dispatch_from_eoa() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
        recipient,
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
        recipient,
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
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;
    let test_sender_receiver_program_id = test_send_receiver.id();

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
        test_send_receiver
            .dispatch(&mailbox_accounts, outbox_dispatch)
            .await
            .unwrap();

    let expected_message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        // The sender should be the program ID because its dispatch authority signed
        sender: test_sender_receiver_program_id.to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient,
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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
        recipient,
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

#[tokio::test]
async fn test_get_recipient_ism_when_specified() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = test_send_receiver.id();

    let ism = Pubkey::new_unique();

    test_send_receiver
        .set_ism(Some(ism), IsmReturnDataMode::EncodeOption)
        .await
        .unwrap();

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    assert_eq!(recipient_ism, ism);
}

#[tokio::test]
async fn test_get_recipient_ism_when_option_none_returned() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = test_send_receiver.id();

    let ism = None;

    test_send_receiver
        .set_ism(ism, IsmReturnDataMode::EncodeOption)
        .await
        .unwrap();

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    // Expect the default ISM to be used
    assert_eq!(recipient_ism, mailbox_accounts.default_ism);
}

#[tokio::test]
async fn test_get_recipient_ism_when_no_return_data() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = test_send_receiver.id();

    let ism = None;

    test_send_receiver
        .set_ism(
            ism,
            // Return nothing!
            IsmReturnDataMode::ReturnNothing,
        )
        .await
        .unwrap();

    let recipient_ism =
        get_recipient_ism(&mut banks_client, &payer, &mailbox_accounts, recipient_id)
            .await
            .unwrap();
    // Expect the default ISM to be used
    assert_eq!(recipient_ism, mailbox_accounts.default_ism);
}

#[tokio::test]
async fn test_get_recipient_ism_errors_with_malformatted_recipient_ism_return_data() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = test_send_receiver.id();

    let ism = None;

    test_send_receiver
        .set_ism(
            ism,
            // Return some malformmated data
            IsmReturnDataMode::ReturnMalformmatedData,
        )
        .await
        .unwrap();

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

#[tokio::test]
async fn test_process_successful_verify_and_handle() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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

    process(
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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, mut test_ism) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    test_ism.set_accept(false).await.unwrap();

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
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let recipient_id = hyperlane_sealevel_test_send_receiver::id();

    test_send_receiver
        .set_handle_mode(HandleMode::Fail)
        .await
        .unwrap();

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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
            InstructionError::Custom(MailboxError::DestinationDomainNotLocalDomain as u32),
        ),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_process_errors_if_wrong_message_version() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

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
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

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

#[tokio::test]
async fn test_process_errors_if_reentrant() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, mut test_send_receiver, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    test_send_receiver
        .set_handle_mode(HandleMode::ReenterProcess)
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

    let mut accounts = get_process_account_metas(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await
    .unwrap();
    // Add the same accounts to the end, because the test recipient that attempts
    // to reenter will use the rest of the accounts provided in its handler to reenter.
    accounts.extend(accounts.clone());

    let result = process_with_accounts(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
        accounts,
    )
    .await;

    // We use a RefMut of the Inbox PDA's data as a reentrancy guard, so we expect `AccountBorrowFailed`
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::AccountBorrowFailed),
    );

    assert_message_not_processed(&mut banks_client, &mailbox_accounts, message.id()).await;
}

#[tokio::test]
async fn test_inbox_set_default_ism() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let new_default_ism = Pubkey::new_unique();

    // Set the default ISM to the test ISM
    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::InboxSetDefaultIsm(new_default_ism)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] - The Inbox PDA account.
            // 1. [] - The Outbox PDA account.
            // 2. [signer] - The owner of the Mailbox.
            AccountMeta::new(mailbox_accounts.inbox, false),
            AccountMeta::new_readonly(mailbox_accounts.outbox, false),
            AccountMeta::new(payer.pubkey(), true),
        ],
    };

    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Make sure the inbox account was updated.
    assert_inbox(
        &mut banks_client,
        mailbox_accounts.inbox,
        Inbox {
            local_domain: LOCAL_DOMAIN,
            inbox_bump_seed: mailbox_accounts.inbox_bump_seed,
            default_ism: new_default_ism,
            processed_count: 0,
        },
    )
    .await;
}

#[tokio::test]
async fn test_inbox_set_default_ism_errors_if_owner_not_signer() {
    let program_id = mailbox_id();
    let (mut banks_client, payer, _, _) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(&mut banks_client, &program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    let new_default_ism = Pubkey::new_unique();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;

    // Where the payer is a signer but not the owner
    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::InboxSetDefaultIsm(new_default_ism)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] - The Inbox PDA account.
            // 1. [] - The Outbox PDA account.
            // 2. [signer] - The owner of the Mailbox.
            AccountMeta::new(mailbox_accounts.inbox, false),
            AccountMeta::new_readonly(mailbox_accounts.outbox, false),
            AccountMeta::new_readonly(non_owner.pubkey(), true),
        ],
    };
    let result =
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Where the owner is correct but not a signer
    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::InboxSetDefaultIsm(new_default_ism)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] - The Inbox PDA account.
            // 1. [] - The Outbox PDA account.
            // 2. [signer] - The owner of the Mailbox.
            AccountMeta::new(mailbox_accounts.inbox, false),
            AccountMeta::new_readonly(mailbox_accounts.outbox, false),
            AccountMeta::new_readonly(payer.pubkey(), false),
        ],
    };
    let result =
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}
