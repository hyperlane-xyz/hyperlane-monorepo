use hyperlane_core::{Encode, HyperlaneMessage, H256};

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    transaction::Transaction,
};

use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Inbox, InboxAccount, Outbox, OutboxAccount,
        ProcessedMessage, ProcessedMessageAccount,
    },
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds, mailbox_processed_message_pda_seeds,
};

use hyperlane_test_utils::MailboxAccounts;

pub async fn dispatch_from_payer(
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

pub async fn assert_dispatched_message(
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

pub async fn assert_outbox(
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

pub async fn assert_inbox(
    banks_client: &mut BanksClient,
    inbox_pubkey: Pubkey,
    expected_inbox: Inbox,
) {
    // Check that the inbox account was updated.
    let inbox_account = banks_client
        .get_account(inbox_pubkey)
        .await
        .unwrap()
        .unwrap();

    let inbox = InboxAccount::fetch(&mut &inbox_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(*inbox, expected_inbox,);
}

pub async fn assert_processed_message(
    banks_client: &mut BanksClient,
    process_tx_signature: Signature,
    processed_message_account_key: Pubkey,
    expected_message: &HyperlaneMessage,
    expected_sequence: u64,
) {
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

pub async fn assert_message_not_processed(
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
