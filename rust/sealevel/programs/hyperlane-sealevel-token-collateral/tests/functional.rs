//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use hyperlane_core::{Encode, HyperlaneMessage, H256};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
};
use std::collections::HashMap;

use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessage, DispatchedMessageAccount},
    instruction::{InboxProcess, Init as InitMailbox, Instruction as MailboxInstruction},
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds,
    instruction::Instruction as HyperlaneTokenInstruction, plugin::CollateralPlugin,
    processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, TransferRemote},
    message::TokenMessage,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::{
    extension::StateWithExtensions, instruction::initialize_mint2, state::Account,
};

/// There are 1e9 lamports in one SOL.
const ONE_SOL_IN_LAMPORTS: u64 = 1000000000;

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_collateral::id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_collateral",
        program_id,
        processor!(process_instruction),
    );

    program_test.add_program(
        "spl_token_2022",
        spl_token_2022::id(),
        processor!(spl_token_2022::processor::Processor::process),
    );

    program_test.add_program(
        "spl_associated_token_account",
        spl_associated_token_account::id(),
        processor!(spl_associated_token_account::processor::process_instruction),
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

    let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    transfer_lamports(banks_client, payer, &keypair.pubkey(), lamports).await;
    keypair
}

async fn transfer_lamports(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    to: &Pubkey,
    lamports: u64,
) {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            to,
            lamports,
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
}

struct MailboxAccounts {
    program: Pubkey,
    #[allow(dead_code)]
    inbox: Pubkey,
    outbox: Pubkey,
}

async fn initialize_mailbox(
    banks_client: &mut BanksClient,
    mailbox_program_id: &Pubkey,
    payer: &Keypair,
    local_domain: u32,
) -> MailboxAccounts {
    let (inbox_account, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), mailbox_program_id);
    let (outbox_account, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), mailbox_program_id);

    let ixn = MailboxInstruction::Init(InitMailbox {
        local_domain,
        inbox_bump_seed: inbox_bump,
        outbox_bump_seed: outbox_bump,
    });
    let init_instruction = Instruction {
        program_id: *mailbox_program_id,
        data: ixn.into_instruction_data().unwrap(),
        accounts: vec![
            AccountMeta::new(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(inbox_account, false),
            AccountMeta::new(outbox_account, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_signed_with_payer(
        &[init_instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    MailboxAccounts {
        program: *mailbox_program_id,
        inbox: inbox_account,
        outbox: outbox_account,
    }
}

async fn initialize_mint(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    decimals: u8,
) -> (Pubkey, Keypair) {
    let mint = Keypair::new();
    let mint_authority = new_funded_keypair(banks_client, payer, ONE_SOL_IN_LAMPORTS).await;

    let payer_pubkey = payer.pubkey();
    let mint_pubkey = mint.pubkey();
    let mint_authority_pubkey = mint_authority.pubkey();

    let init_mint_instruction = initialize_mint2(
        &spl_token_2022::id(),
        &mint_pubkey,
        &mint_authority_pubkey,
        // No freeze authority
        None,
        decimals,
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[
            system_instruction::create_account(
                &payer_pubkey,
                &mint_pubkey,
                Rent::default().minimum_balance(spl_token_2022::state::Mint::LEN),
                spl_token_2022::state::Mint::LEN.try_into().unwrap(),
                &spl_token_2022::id(),
            ),
            init_mint_instruction,
        ],
        Some(&payer_pubkey),
    );
    transaction.sign(&[payer, &mint], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    (mint_pubkey, mint_authority)
}

async fn create_and_mint_to_ata(
    banks_client: &mut BanksClient,
    mint: &Pubkey,
    mint_authority: &Keypair,
    payer: &Keypair,
    recipient_wallet: &Pubkey,
    amount: u64,
) -> Pubkey {
    let mint_authority_pubkey = mint_authority.pubkey();

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_wallet,
            mint,
            &spl_token_2022::id(),
        );

    // Create and init (this does both) associated token account if necessary.
    let create_ata_instruction = create_associated_token_account_idempotent(
        &payer.pubkey(),
        recipient_wallet,
        mint,
        &spl_token_2022::id(),
    );

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction =
        Transaction::new_with_payer(&[create_ata_instruction], Some(&payer.pubkey()));
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // Mint tokens to the associated token account.
    if amount > 0 {
        let mint_to_ata_instruction = spl_token_2022::instruction::mint_to(
            &spl_token_2022::id(),
            mint,
            &recipient_associated_token_account,
            &mint_authority_pubkey,
            &[],
            amount,
        )
        .unwrap();

        let mut transaction =
            Transaction::new_with_payer(&[mint_to_ata_instruction], Some(&mint_authority_pubkey));
        transaction.sign(&[mint_authority], recent_blockhash);
        banks_client.process_transaction(transaction).await.unwrap();
    }

    recipient_associated_token_account
}

struct HyperlaneTokenAccounts {
    token: Pubkey,
    token_bump: u8,
    mailbox_process_authority: Pubkey,
    dispatch_authority: Pubkey,
    dispatch_authority_bump: u8,
    escrow: Pubkey,
    escrow_bump: u8,
    ata_payer: Pubkey,
    ata_payer_bump: u8,
}

async fn initialize_hyperlane_token(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mint: &Pubkey,
) -> Result<HyperlaneTokenAccounts, BanksClientError> {
    let local_domain: u32 = 1234;
    let remote_domain: u32 = 4321;
    let local_decimals: u8 = 8;

    let (mailbox_process_authority_key, _mailbox_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &hyperlane_sealevel_mailbox::id(),
        );

    let (token_account_key, token_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

    let (dispatch_authority_key, dispatch_authority_seed) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);

    let (escrow_account_key, escrow_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), program_id);

    let (ata_payer_account_key, ata_payer_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &HyperlaneTokenInstruction::Init(Init {
                mailbox: hyperlane_sealevel_mailbox::id(),
            })
            .into_instruction_data()
            .unwrap(),
            vec![
                // 0. [executable] The system program.
                // 1. [writable] The token PDA account.
                // 2. [writable] The dispatch authority PDA account.
                // 3. [signer] The payer.
                // 4. [] The mint.
                // 5. [executable] The SPL token 2022 program.
                // 6. [executable] The Rent sysvar program.
                // 7. [writable] The escrow PDA account.
                // 8. [writable] The ATA payer PDA account.
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(token_account_key, false),
                AccountMeta::new(dispatch_authority_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(*mint, false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
                AccountMeta::new(escrow_account_key, false),
                AccountMeta::new(ata_payer_account_key, false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await?;

    Ok(HyperlaneTokenAccounts {
        token: token_account_key,
        token_bump: token_account_bump_seed,
        mailbox_process_authority: mailbox_process_authority_key,
        dispatch_authority: dispatch_authority_key,
        dispatch_authority_bump: dispatch_authority_seed,
        escrow: escrow_account_key,
        escrow_bump: escrow_account_bump_seed,
        ata_payer: ata_payer_account_key,
        ata_payer_bump: ata_payer_account_bump_seed,
    })
}

async fn enroll_remote_router(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    token_account: &Pubkey,
    domain: u32,
    router: H256,
) {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Enroll the remote router
    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &HyperlaneTokenInstruction::EnrollRemoteRouter(RemoteRouterConfig {
                domain,
                router: Some(router),
            })
            .into_instruction_data()
            .unwrap(),
            vec![
                AccountMeta::new(*token_account, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn assert_balance(banks_client: &mut BanksClient, account: &Pubkey, expected_balance: u64) {
    let data = banks_client
        .get_account(*account)
        .await
        .unwrap()
        .unwrap()
        .data;
    let state = StateWithExtensions::<Account>::unpack(&data).unwrap();
    assert_eq!(state.base.amount, expected_balance);
}

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_token_collateral::id();
    let mailbox_program_id = hyperlane_sealevel_mailbox::id();

    let (mut banks_client, payer) = setup_client().await;

    let local_domain: u32 = 1234;
    let remote_domain: u32 = 4321;
    let local_decimals: u8 = 8;

    let mailbox_accounts =
        initialize_mailbox(&mut banks_client, &mailbox_program_id, &payer, local_domain).await;

    let (mint, mint_authority) = initialize_mint(&mut banks_client, &payer, local_decimals).await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, &mint)
            .await
            .unwrap();

    // Get the token account.
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        token,
        Box::new(HyperlaneToken {
            bump: hyperlane_token_accounts.token_bump,
            mailbox: mailbox_accounts.program,
            mailbox_process_authority: hyperlane_token_accounts.mailbox_process_authority,
            dispatch_authority_bump: hyperlane_token_accounts.dispatch_authority_bump,
            owner: Some(payer.pubkey()),
            remote_routers: HashMap::new(),
            plugin_data: CollateralPlugin {
                mint,
                escrow: hyperlane_token_accounts.escrow,
                escrow_bump: hyperlane_token_accounts.escrow_bump,
                ata_payer_bump: hyperlane_token_accounts.ata_payer_bump,
            },
        }),
    );

    // Verify the escrow account was created.
    let escrow_account = banks_client
        .get_account(hyperlane_token_accounts.escrow)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(escrow_account.owner, spl_token_2022::id());
    assert!(escrow_account.data.len() > 0);

    // Verify the ATA payer account was created.
    let ata_payer_account = banks_client
        .get_account(hyperlane_token_accounts.ata_payer)
        .await
        .unwrap()
        .unwrap();
    assert!(ata_payer_account.lamports > 0);
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = hyperlane_sealevel_token_collateral::id();
    let mailbox_program_id = hyperlane_sealevel_mailbox::id();

    let (mut banks_client, payer) = setup_client().await;

    let local_domain: u32 = 1234;
    let remote_domain: u32 = 4321;
    let local_decimals: u8 = 8;

    let mailbox_accounts =
        initialize_mailbox(&mut banks_client, &mailbox_program_id, &payer, local_domain).await;

    let (mint, mint_authority) = initialize_mint(&mut banks_client, &payer, local_decimals).await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, &mint)
            .await
            .unwrap();

    // To ensure a different signature is used, we'll use a different payer
    let init_result =
        initialize_hyperlane_token(&program_id, &mut banks_client, &mint_authority, &mint).await;

    // BanksClientError doesn't implement Eq, but TransactionError does
    if let BanksClientError::TransactionError(tx_err) = init_result.err().unwrap() {
        assert_eq!(
            tx_err,
            TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized)
        );
    } else {
        panic!("expected TransactionError");
    }
}

#[tokio::test]
async fn test_transfer_remote() {
    let program_id = hyperlane_sealevel_token_collateral::id();
    let mailbox_program_id = hyperlane_sealevel_mailbox::id();

    let (mut banks_client, payer) = setup_client().await;

    let local_domain: u32 = 1234;
    let remote_domain: u32 = 4321;
    let local_decimals: u8 = 8;

    let mailbox_accounts =
        initialize_mailbox(&mut banks_client, &mailbox_program_id, &payer, local_domain).await;

    let (mint, mint_authority) = initialize_mint(&mut banks_client, &payer, local_decimals).await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, &mint)
            .await
            .unwrap();

    // Enroll the remote router
    let remote_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        remote_domain,
        remote_router,
    )
    .await;

    let token_sender = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();
    // Mint 100 tokens to the token sender's ATA
    let token_sender_ata = create_and_mint_to_ata(
        &mut banks_client,
        &mint,
        &mint_authority,
        &payer,
        &token_sender_pubkey,
        100 * 10u64.pow(8),
    )
    .await;

    // Call transfer_remote
    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );

    let remote_token_recipient = H256::random();
    // Tranfser 69 tokens.
    let transfer_amount = 69 * 10u64.pow(8);

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                destination_domain: remote_domain,
                recipient: remote_token_recipient,
                amount_or_id: transfer_amount.into(),
            })
            .into_instruction_data()
            .unwrap(),
            // 0.   [executable] The system program.
            // 1.   [executable] The spl_noop program.
            // 2.   [] The token PDA account.
            // 3.   [executable] The mailbox program.
            // 4.   [writeable] The mailbox outbox account.
            // 5.   [] Message dispatch authority.
            // 6.   [signer] The token sender and mailbox payer.
            // 7.   [signer] Unique message account.
            // 8.   [writeable] Message storage PDA.
            // 9.   [executable] The spl_token_2022 program.
            // 10.  [] The mint.
            // 11.  [writeable] The token sender's associated token account, from which tokens will be sent.
            // 12.  [] The escrow PDA account.
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new(mint, false),
                AccountMeta::new(token_sender_ata, false),
                AccountMeta::new(hyperlane_token_accounts.escrow, false),
            ],
        )],
        Some(&token_sender_pubkey),
    );
    transaction.sign(
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the token sender's ATA balance is 31 full tokens.
    assert_balance(&mut banks_client, &token_sender_ata, 31 * 10u64.pow(8)).await;

    // And that the escrow's balance is 69 tokens.
    assert_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        69 * 10u64.pow(8),
    )
    .await;

    // And let's take a look at the dispatched message account data to verify the message looks right.
    let dispatched_message_account_data = banks_client
        .get_account(dispatched_message_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let dispatched_message =
        DispatchedMessageAccount::fetch(&mut &dispatched_message_account_data[..])
            .unwrap()
            .into_inner();

    let transfer_remote_tx_status = banks_client
        .get_transaction_status(tx_signature)
        .await
        .unwrap()
        .unwrap();

    let message = HyperlaneMessage {
        version: 0,
        nonce: 0,
        origin: local_domain,
        sender: program_id.to_bytes().into(),
        destination: remote_domain,
        recipient: remote_router,
        body: TokenMessage::new(remote_token_recipient, transfer_amount.into(), vec![]).to_vec(),
    };

    assert_eq!(
        dispatched_message,
        Box::new(DispatchedMessage::new(
            message.nonce,
            transfer_remote_tx_status.slot,
            unique_message_account_keypair.pubkey(),
            message.to_vec(),
        )),
    );
}

// // Try minting some innit

// let recipient_keypair = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
// let recipient: H256 = recipient_keypair.pubkey().to_bytes().into();

// let recipient_associated_token_account =
//     spl_associated_token_account::get_associated_token_address_with_program_id(
//         &recipient_keypair.pubkey(),
//         &mint_account_key,
//         &spl_token_2022::id(),
//     );

// // ATA payer must have a balance to create new ATAs
// transfer_lamports(&mut banks_client, &payer, &ata_payer_account_key, ONE_SOL_IN_LAMPORTS).await;

// let (process_authority_account_key, _process_authority_bump) = Pubkey::find_program_address(
//     mailbox_process_authority_pda_seeds!(program_id),
//     &mailbox_program_id,
// );

// let message = HyperlaneMessage {
//     version: 0,
//     nonce: 0,
//     origin: remote_domain,
//     sender: remote_router,
//     destination: local_domain,
//     recipient: H256::from(program_id.to_bytes()),
//     body: TokenMessage::new(recipient, 100u64.into(), vec![]).to_vec(),
// };

// let (processed_message_account_key, _processed_message_account_bump) =
//     Pubkey::find_program_address(
//         mailbox_processed_message_pda_seeds!(message.id()),
//         &mailbox_program_id,
//     );

// let mut transaction = Transaction::new_with_payer(
//     &[Instruction::new_with_borsh(
//         mailbox_program_id,
//         &MailboxInstruction::InboxProcess(InboxProcess {
//             metadata: vec![],
//             message: message.to_vec(),
//         }),
//         vec![
//             AccountMeta::new_readonly(payer.pubkey(), true),
//             AccountMeta::new_readonly(solana_program::system_program::id(), false),
//             AccountMeta::new(mailbox_accounts.inbox, false),
//             AccountMeta::new_readonly(process_authority_account_key, false),
//             AccountMeta::new(processed_message_account_key, false),
//             AccountMeta::new_readonly(spl_noop::id(), false),
//             // ISM
//             AccountMeta::new_readonly(hyperlane_sealevel_ism_rubber_stamp::id(), false),
//             // Recipient
//             AccountMeta::new_readonly(program_id, false),
//             // Recipient.verify accounts
//             AccountMeta::new_readonly(solana_program::system_program::id(), false),
//             AccountMeta::new_readonly(spl_noop::id(), false),
//             AccountMeta::new_readonly(token_account_key, false),
//             AccountMeta::new_readonly(recipient_keypair.pubkey(), false),
//             AccountMeta::new_readonly(spl_token_2022::id(), false),
//             AccountMeta::new_readonly(spl_associated_token_account::id(), false),
//             AccountMeta::new(mint_account_key, false),
//             AccountMeta::new(recipient_associated_token_account, false),
//             AccountMeta::new(ata_payer_account_key, false),
//         ],
//     )],
//     Some(&payer.pubkey()),
// );
// transaction.sign(&[&payer], recent_blockhash);
// banks_client.process_transaction(transaction).await.unwrap();

// let recipient_associated_token_account_data = banks_client
//     .get_account(recipient_associated_token_account)
//     .await
//     .unwrap()
//     .unwrap()
//     .data;
// let recipient_ata_state =
//     StateWithExtensions::<Account>::unpack(&recipient_associated_token_account_data).unwrap();

// // Check that the recipient got the tokens!
// // TODO add total supply check
// assert_eq!(recipient_ata_state.base.amount, 100u64);

// // Let's try transferring some tokens to the remote domain now

// let unique_message_account_keypair = Keypair::new();
// let (dispatched_message_key, _dispatched_message_bump) = Pubkey::find_program_address(
//     mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
//     &mailbox_program_id,
// );

// let mut transaction = Transaction::new_with_payer(
//     &[Instruction::new_with_bytes(
//         program_id,
//         &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
//             destination_domain: remote_domain,
//             /// TODO imply this from Router
//             destination_program_id: H256::random(),
//             recipient: H256::random(),
//             amount_or_id: 69u64.into(),
//         })
//         .into_instruction_data()
//         .unwrap(),
//         vec![
//             AccountMeta::new_readonly(solana_program::system_program::id(), false),
//             AccountMeta::new_readonly(spl_noop::id(), false),
//             AccountMeta::new_readonly(token_account_key, false),
//             AccountMeta::new_readonly(mailbox_accounts.program, false),
//             AccountMeta::new(mailbox_accounts.outbox, false),
//             AccountMeta::new_readonly(dispatch_authority_key, false),
//             AccountMeta::new_readonly(recipient_keypair.pubkey(), true),
//             AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
//             AccountMeta::new(dispatched_message_key, false),
//             AccountMeta::new_readonly(spl_token_2022::id(), false),
//             AccountMeta::new(mint_account_key, false),
//             AccountMeta::new(recipient_associated_token_account, false),
//         ],
//     )],
//     Some(&recipient_keypair.pubkey()),
// );
// transaction.sign(
//     &[&recipient_keypair, &unique_message_account_keypair],
//     recent_blockhash,
// );
// banks_client.process_transaction(transaction).await.unwrap();

// let recipient_associated_token_account_data = banks_client
//     .get_account(recipient_associated_token_account)
//     .await
//     .unwrap()
//     .unwrap()
//     .data;
// let recipient_ata_state =
//     StateWithExtensions::<Account>::unpack(&recipient_associated_token_account_data).unwrap();

// // Check that the sender burned the tokens!
// // TODO add total supply check
// assert_eq!(recipient_ata_state.base.amount, 31u64);
// }
