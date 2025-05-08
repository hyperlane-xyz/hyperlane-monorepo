//! Functional tests for the Interchain Accounts sealevel program.
//!
//! Only covers init & ownership transfer for now.  Remote‑call dispatch
//! requires a Mailbox & IGP stack and will be added later.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256};
use hyperlane_interchain_accounts::InterchainAccountMessage;
use hyperlane_sealevel_interchain_accounts::{
    accounts::InterchainAccountStorageAccount,
    instruction::{
        init_instruction, transfer_ownership_instruction, CallRemoteMessage,
        InterchainAccountInstruction,
    },
    processor::process_instruction,
    program_storage_pda_seeds,
};
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessage, DispatchedMessageAccount},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds, spl_noop,
};
use hyperlane_test_utils::{initialize_mailbox, mailbox_id, MailboxAccounts};
use solana_program::{pubkey, pubkey::Pubkey};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const REMOTE_DOMAIN: u32 = 4242;
const GAS_LIMIT: u64 = 300_000;

/// Convenience: hard‑coded program id so we don't have to redeclare it.
fn ica_program_id() -> Pubkey {
    pubkey!("682KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1")
}

/// Build a ProgramTest with the Interchain Accounts program loaded.
async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = ica_program_id();
    let mut pt = ProgramTest::new(
        "interchain_accounts", // cargo‑crate‑name
        program_id,
        processor!(process_instruction),
    );

    pt.add_program("spl_noop", spl_noop::id(), processor!(spl_noop::noop));

    let mailbox_program_id = mailbox_id();
    pt.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    let (client, payer, _hash) = pt.start().await;
    (client, payer)
}

async fn initialize_ica(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    program_id: &Pubkey,
    mailbox_program: &MailboxAccounts,
    local_domain: u32,
) -> Result<Pubkey, BanksClientError> {
    // PDA we expect to be created.
    let (storage_pda, _bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

    let ix = init_instruction(
        *program_id,
        payer.pubkey(),
        local_domain,
        mailbox_program.program,
        None,
        None,
        Some(payer.pubkey()),
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await?;

    Ok(storage_pda)
}

#[tokio::test]
async fn test_initialize() {
    const LOCAL_DOMAIN: u32 = 1337;

    let (mut banks_client, payer) = setup_client().await;
    let program_id = ica_program_id();

    // PDA we expect to be created.
    let (storage_pda, _bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), &program_id);

    // Build the init instruction (owner == payer).
    let ix = init_instruction(
        program_id,
        payer.pubkey(),
        LOCAL_DOMAIN,
        mailbox_id(),
        None,                 // ISM
        None,                 // IGP
        Some(payer.pubkey()), // owner
    )
    .unwrap();

    // Send tx.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    // Fetch storage and assert fields.
    let storage_account = banks_client
        .get_account(storage_pda)
        .await
        .unwrap()
        .expect("storage PDA not created");

    let storage = InterchainAccountStorageAccount::fetch(&mut &storage_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(storage.local_domain, LOCAL_DOMAIN);
    assert_eq!(storage.owner, Some(payer.pubkey()));
}

#[tokio::test]
async fn test_transfer_ownership() {
    const LOCAL_DOMAIN: u32 = 2222;

    let (mut banks_client, payer) = setup_client().await;
    let program_id = ica_program_id();

    let (storage_pda, _bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), &program_id);

    // 1) init
    let init_ix = init_instruction(
        program_id,
        payer.pubkey(),
        LOCAL_DOMAIN,
        Pubkey::new_unique(),
        None,
        None,
        Some(payer.pubkey()),
    )
    .unwrap();

    // 2) transfer ownership to a new key
    let new_owner = Pubkey::new_unique();
    let xfer_ix =
        transfer_ownership_instruction(program_id, payer.pubkey(), Some(new_owner)).unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[init_ix, xfer_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    // Verify owner updated
    let storage_account = banks_client
        .get_account(storage_pda)
        .await
        .unwrap()
        .unwrap();
    let storage = InterchainAccountStorageAccount::fetch(&mut &storage_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(storage.owner, Some(new_owner));
}

#[tokio::test]
async fn test_transfer_ownership_fails_without_owner_sig() {
    const LOCAL_DOMAIN: u32 = 5555;

    let (mut banks_client, payer) = setup_client().await;
    let program_id = ica_program_id();

    // init (owner = payer)
    let init_ix = init_instruction(
        program_id,
        payer.pubkey(),
        LOCAL_DOMAIN,
        Pubkey::new_unique(),
        None,
        None,
        Some(payer.pubkey()),
    )
    .unwrap();

    // build transfer ix signed by random key (should fail)
    let rogue = Keypair::new();
    let xfer_ix =
        transfer_ownership_instruction(program_id, rogue.pubkey(), Some(Pubkey::new_unique()))
            .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[init_ix, xfer_ix],
        Some(&payer.pubkey()),
        &[&payer, &rogue],
        recent_blockhash,
    );

    let result = banks_client.process_transaction(tx).await;
    assert!(matches!(
        result,
        Err(BanksClientError::TransactionError(
            TransactionError::InstructionError(_, _)
        ))
    ));
}

#[tokio::test]
async fn test_call_remote_dispatch() {
    const LOCAL_DOMAIN: u32 = 5555;

    println!("Starting test...");

    // 1) Spin up banks client with ICA + Mailbox
    let program_id = ica_program_id();
    let mailbox_program_id = mailbox_id();

    let (mut banks_client, payer) = setup_client().await;

    // 2) Initialize Mailbox & ICA
    println!("Initializing mailbox...");
    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        1_000_000,
        Default::default(),
    )
    .await
    .unwrap();

    println!("Initializing ICA...");
    let storage_pda = initialize_ica(
        &mut banks_client,
        &payer,
        &ica_program_id(),
        &mailbox_accounts,
        LOCAL_DOMAIN,
    )
    .await
    .unwrap();

    println!("Preparing transaction...");
    // 3) Fuzz‑safe deterministic call body
    let calls: Vec<u8> = vec![1, 2, 3, 4];
    let router = Some(H256::random());
    let ism = Some(H256::random());
    let salt = Some(H256::random());

    let call_remote_msg = CallRemoteMessage {
        destination: REMOTE_DOMAIN,
        router,
        ism,
        salt,
        gas_limit: GAS_LIMIT,
        calls: calls.clone(),
    };

    // Prep PDAs & unique msg account
    let unique_msg = Keypair::new();
    let (dispatched_message_pda, _disp_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_program_id,
    );

    let (dispatch_authority, _da_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), &program_id);

    let ix = Instruction::new_with_bytes(
        program_id,
        &InterchainAccountInstruction::CallRemote(call_remote_msg)
            .encode()
            .unwrap(),
        // 0.  `[]` Program storage (read-only)
        // 1.  `[signer]` Call remote sender signer.
        // 2.  `[executable]` The Mailbox program.
        // 3.  `[writeable]` Outbox PDA.
        // 4.  `[]` This program's dispatch authority.
        // 5.  `[executable]` System program.
        // 6.  `[executable]` SPL Noop program.
        // 7.  `[signer]` Unique message account.
        // 8.  `[writeable]` Dispatched message PDA. An empty message PDA relating to the seeds
        //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
        vec![
            AccountMeta::new_readonly(storage_pda, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new(mailbox_program_id, false),
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new_readonly(dispatch_authority, false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
            AccountMeta::new_readonly(spl_noop::id(), false),
            AccountMeta::new(unique_msg.pubkey(), true),
            AccountMeta::new(dispatched_message_pda, false),
        ],
    );

    // Send transaction
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &unique_msg],
        recent_blockhash,
    );

    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    let dispatched_message_account_data = banks_client
        .get_account(dispatched_message_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let dispatched_message =
        DispatchedMessageAccount::fetch(&mut &dispatched_message_account_data[..])
            .unwrap()
            .into_inner();

    let call_remote_tx_status = banks_client
        .get_transaction_status(tx_signature)
        .await
        .unwrap()
        .unwrap();

    let owner = H256(payer.pubkey().to_bytes());
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        destination: REMOTE_DOMAIN,
        sender: program_id.to_bytes().into(),
        recipient: router.unwrap(),
        body: InterchainAccountMessage::new(owner, ism, salt, calls).to_vec(),
    };

    assert_eq!(
        dispatched_message,
        Box::new(DispatchedMessage::new(
            message.nonce,
            call_remote_tx_status.slot,
            unique_msg.pubkey(),
            message.to_vec(),
        )),
    );
}
