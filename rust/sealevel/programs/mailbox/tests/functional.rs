use borsh::BorshSerialize;
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
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Inbox, InboxAccount, Outbox, OutboxAccount,
    },
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    processor::process_instruction,
};
use hyperlane_test_send_receiver::TestSendReceiverInstruction;

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
    program_test.add_program(
        "hyperlane_sealevel_ism_rubber_stamp",
        hyperlane_sealevel_ism_rubber_stamp::id(),
        processor!(hyperlane_sealevel_ism_rubber_stamp::process_instruction),
    );

    program_test.add_program(
        "hyperlane_test_send_receiver",
        hyperlane_test_send_receiver::id(),
        processor!(hyperlane_test_send_receiver::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
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
    let test_sender_receiver_program_id = hyperlane_test_send_receiver::id();
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
