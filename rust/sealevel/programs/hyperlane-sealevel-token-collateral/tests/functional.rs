//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use std::collections::HashMap;

use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::{
    accounts::{GasPaymentAccount, GasPaymentData, InterchainGasPaymasterType},
    igp_gas_payment_pda_seeds,
};
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessage, DispatchedMessageAccount},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    mailbox_process_authority_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds,
    plugin::CollateralPlugin, processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction, TransferRemote},
};
use hyperlane_test_utils::{
    assert_token_balance, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, transfer_lamports, IgpAccounts,
};
use hyperlane_warp_route::TokenMessage;
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::instruction::initialize_mint2;

/// There are 1e9 lamports in one SOL.
const ONE_SOL_IN_LAMPORTS: u64 = 1000000000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 8;
const LOCAL_DECIMALS_U32: u32 = LOCAL_DECIMALS as u32;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
const REMOTE_GAS_AMOUNT: u64 = 200000;
// Same for spl_token_2022 and spl_token
const MINT_ACCOUNT_LEN: usize = spl_token_2022::state::Mint::LEN;

fn hyperlane_sealevel_token_collateral_id() -> Pubkey {
    pubkey!("G8t1qe3YnYvhi1zS9ioUXuVFkwhBgvfHaLJt5X6PF18z")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_collateral_id();
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
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );

    program_test.add_program(
        "spl_associated_token_account",
        spl_associated_token_account::id(),
        processor!(spl_associated_token_account::processor::process_instruction),
    );

    program_test.add_program("spl_noop", spl_noop::id(), processor!(spl_noop::noop));

    let mailbox_program_id = mailbox_id();
    program_test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_igp",
        igp_program_id(),
        processor!(hyperlane_sealevel_igp::processor::process_instruction),
    );

    // This serves as the default ISM on the Mailbox
    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

async fn initialize_mint(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    decimals: u8,
    spl_token_program: &Pubkey,
) -> (Pubkey, Keypair) {
    let mint = Keypair::new();
    let mint_authority = new_funded_keypair(banks_client, payer, ONE_SOL_IN_LAMPORTS).await;

    let payer_pubkey = payer.pubkey();
    let mint_pubkey = mint.pubkey();
    let mint_authority_pubkey = mint_authority.pubkey();

    let init_mint_instruction = initialize_mint2(
        spl_token_program,
        &mint_pubkey,
        &mint_authority_pubkey,
        // No freeze authority
        None,
        decimals,
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &payer_pubkey,
                &mint_pubkey,
                Rent::default().minimum_balance(MINT_ACCOUNT_LEN),
                MINT_ACCOUNT_LEN.try_into().unwrap(),
                spl_token_program,
            ),
            init_mint_instruction,
        ],
        Some(&payer_pubkey),
        &[payer, &mint],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    (mint_pubkey, mint_authority)
}

async fn mint_to(
    banks_client: &mut BanksClient,
    spl_token_program_id: &Pubkey,
    mint: &Pubkey,
    mint_authority: &Keypair,
    recipient_account: &Pubkey,
    amount: u64,
) {
    let mint_instruction = spl_token_2022::instruction::mint_to(
        spl_token_program_id,
        mint,
        recipient_account,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[mint_instruction],
        Some(&mint_authority.pubkey()),
        &[mint_authority],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

async fn create_and_mint_to_ata(
    banks_client: &mut BanksClient,
    spl_token_program_id: &Pubkey,
    mint: &Pubkey,
    mint_authority: &Keypair,
    payer: &Keypair,
    recipient_wallet: &Pubkey,
    amount: u64,
) -> Pubkey {
    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            recipient_wallet,
            mint,
            spl_token_program_id,
        );

    // Create and init (this does both) associated token account if necessary.
    let create_ata_instruction = create_associated_token_account_idempotent(
        &payer.pubkey(),
        recipient_wallet,
        mint,
        spl_token_program_id,
    );

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[create_ata_instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Mint tokens to the associated token account.
    if amount > 0 {
        mint_to(
            banks_client,
            spl_token_program_id,
            mint,
            mint_authority,
            &recipient_associated_token_account,
            amount,
        )
        .await;
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
    igp_accounts: Option<&IgpAccounts>,
    mint: &Pubkey,
    spl_token_program: &Pubkey,
) -> Result<HyperlaneTokenAccounts, BanksClientError> {
    let (mailbox_process_authority_key, _mailbox_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &mailbox_id(),
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
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &HyperlaneTokenInstruction::Init(Init {
                mailbox: mailbox_id(),
                interchain_security_module: None,
                interchain_gas_paymaster: igp_accounts.map(|igp_accounts| {
                    (
                        igp_accounts.program,
                        InterchainGasPaymasterType::OverheadIgp(igp_accounts.overhead_igp),
                    )
                }),
                decimals: LOCAL_DECIMALS,
                remote_decimals: REMOTE_DECIMALS,
            })
            .encode()
            .unwrap(),
            vec![
                // 0. `[executable]` The system program.
                // 1. `[writable]` The token PDA account.
                // 2. `[writable]` The dispatch authority PDA account.
                // 3. `[signer]` The payer.
                // 4. `[executable]` The SPL token program for the mint, i.e. either SPL token program or the 2022 version.
                // 5. `[]` The mint.
                // 6. `[executable]` The Rent sysvar program.
                // 7. `[writable]` The escrow PDA account.
                // 8. `[writable]` The ATA payer PDA account.
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(token_account_key, false),
                AccountMeta::new(dispatch_authority_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(*spl_token_program, false),
                AccountMeta::new(*mint, false),
                AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
                AccountMeta::new(escrow_account_key, false),
                AccountMeta::new(ata_payer_account_key, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    // Set destination gas configs
    set_destination_gas_config(
        banks_client,
        program_id,
        payer,
        &token_account_key,
        REMOTE_DOMAIN,
        REMOTE_GAS_AMOUNT,
    )
    .await?;

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
) -> Result<(), BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Enroll the remote router
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &HyperlaneTokenInstruction::EnrollRemoteRouter(RemoteRouterConfig {
                domain,
                router: Some(router),
            })
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(*token_account, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    Ok(())
}

async fn set_destination_gas_config(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    token_account: &Pubkey,
    domain: u32,
    gas: u64,
) -> Result<(), BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Enroll the remote router
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &HyperlaneTokenInstruction::SetDestinationGasConfigs(vec![GasRouterConfig {
                domain,
                gas: Some(gas),
            }])
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(*token_account, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    Ok(())
}

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let mailbox_program_id = mailbox_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    let igp_accounts =
        initialize_igp_accounts(&mut banks_client, &igp_program_id(), &payer, REMOTE_DOMAIN)
            .await
            .unwrap();

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        Some(&igp_accounts),
        &mint,
        &spl_token_program_id,
    )
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
            decimals: LOCAL_DECIMALS,
            remote_decimals: REMOTE_DECIMALS,
            owner: Some(payer.pubkey()),
            interchain_security_module: None,
            interchain_gas_paymaster: Some((
                igp_accounts.program,
                InterchainGasPaymasterType::OverheadIgp(igp_accounts.overhead_igp),
            )),
            destination_gas: HashMap::from([(REMOTE_DOMAIN, REMOTE_GAS_AMOUNT)]),
            remote_routers: HashMap::new(),
            plugin_data: CollateralPlugin {
                spl_token_program: spl_token_2022::id(),
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
    assert!(!escrow_account.data.is_empty());

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
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // To ensure a different signature is used, we'll use a different payer
    let init_result = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &mint_authority,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await;

    assert_transaction_error(
        init_result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

async fn test_transfer_remote(spl_token_program_id: Pubkey) {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let mailbox_program_id = mailbox_id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    let igp_accounts =
        initialize_igp_accounts(&mut banks_client, &igp_program_id(), &payer, REMOTE_DOMAIN)
            .await
            .unwrap();

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        Some(&igp_accounts),
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Enroll the remote router
    let remote_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    let token_sender = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();
    // Mint 100 tokens to the token sender's ATA
    let token_sender_ata = create_and_mint_to_ata(
        &mut banks_client,
        &spl_token_program_id,
        &mint,
        &mint_authority,
        &payer,
        &token_sender_pubkey,
        100 * 10u64.pow(LOCAL_DECIMALS_U32),
    )
    .await;

    // Call transfer_remote
    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _gas_payment_pda_bump) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    let remote_token_recipient = H256::random();
    // Transfer 69 tokens.
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount =
        convert_decimals(transfer_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                destination_domain: REMOTE_DOMAIN,
                recipient: remote_token_recipient,
                amount_or_id: transfer_amount.into(),
            })
            .encode()
            .unwrap(),
            // 0.  `[executable]` The system program.
            // 1.  `[executable]` The spl_noop program.
            // 2.  `[]` The token PDA account.
            // 3.  `[executable]` The mailbox program.
            // 4.  `[writeable]` The mailbox outbox account.
            // 5.  `[]` Message dispatch authority.
            // 6.  `[signer]` The token sender and mailbox payer.
            // 7.  `[signer]` Unique message account.
            // 8.  `[writeable]` Message storage PDA.
            //     ---- If using an IGP ----
            // 9.  `[executable]` The IGP program.
            // 10. `[writeable]` The IGP program data.
            // 11. `[writeable]` Gas payment PDA.
            // 12. `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
            // 13. `[writeable]` The IGP account.
            //      ---- End if ----
            // 14. `[executable]` The spl_token_2022 program.
            // 15. `[writeable]` The mint.
            // 16. `[writeable]` The token sender's associated token account, from which tokens will be sent.
            // 17. `[writeable]` The escrow PDA account.
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
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new(mint, false),
                AccountMeta::new(token_sender_ata, false),
                AccountMeta::new(hyperlane_token_accounts.escrow, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the token sender's ATA balance is 31 full tokens.
    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        31 * 10u64.pow(LOCAL_DECIMALS_U32),
    )
    .await;

    // And that the escrow's balance is 69 tokens.
    assert_token_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        69 * 10u64.pow(LOCAL_DECIMALS_U32),
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
        version: 3,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        sender: program_id.to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: remote_router,
        // Expect the remote_transfer_amount to be in the message.
        body: TokenMessage::new(remote_token_recipient, remote_transfer_amount, vec![]).to_vec(),
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

    // And let's also look at the gas payment account to verify the gas payment looks right.
    let gas_payment_account_data = banks_client
        .get_account(gas_payment_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let gas_payment = GasPaymentAccount::fetch(&mut &gas_payment_account_data[..])
        .unwrap()
        .into_inner();

    assert_eq!(
        *gas_payment,
        GasPaymentData {
            sequence_number: 0,
            igp: igp_accounts.igp,
            destination_domain: REMOTE_DOMAIN,
            message_id: message.id(),
            gas_amount: REMOTE_GAS_AMOUNT,
            unique_gas_payment_pubkey: unique_message_account_keypair.pubkey(),
            slot: transfer_remote_tx_status.slot,
            payment: REMOTE_GAS_AMOUNT
        }
        .into(),
    );
}

// Test transfer_remote with spl_token
#[tokio::test]
async fn test_transfer_remote_spl_token() {
    test_transfer_remote(spl_token_2022::id()).await;
}

// Test transfer_remote with spl_token_2022
#[tokio::test]
async fn test_transfer_remote_spl_token_2022() {
    test_transfer_remote(spl_token_2022::id()).await;
}

async fn transfer_from_remote(
    initial_escrow_balance: u64,
    remote_transfer_amount: U256,
    sender_override: Option<H256>,
    origin_override: Option<u32>,
    spl_token_program_id: Pubkey,
) -> Result<(BanksClient, HyperlaneTokenAccounts, Pubkey), BanksClientError> {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let mailbox_program_id = mailbox_id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    let igp_accounts =
        initialize_igp_accounts(&mut banks_client, &igp_program_id(), &payer, REMOTE_DOMAIN)
            .await
            .unwrap();

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        Some(&igp_accounts),
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();
    // ATA payer must have a balance to create new ATAs
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Enroll the remote router
    let remote_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    // Give an initial balance to the escrow account which will be used by the
    // transfer_from_remote.
    mint_to(
        &mut banks_client,
        &spl_token_program_id,
        &mint,
        &mint_authority,
        &hyperlane_token_accounts.escrow,
        initial_escrow_balance,
    )
    .await;

    let recipient_pubkey = Pubkey::new_unique();
    let recipient: H256 = recipient_pubkey.to_bytes().into();

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_pubkey,
            &mint,
            &spl_token_program_id,
        );

    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: origin_override.unwrap_or(REMOTE_DOMAIN),
        // Default to the remote router as the sender
        sender: sender_override.unwrap_or(remote_router),
        destination: LOCAL_DOMAIN,
        recipient: program_id.to_bytes().into(),
        body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
    };

    process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await?;

    Ok((
        banks_client,
        hyperlane_token_accounts,
        recipient_associated_token_account,
    ))
}

// Tests when the SPL token is the non-2022 version
#[tokio::test]
async fn test_transfer_from_remote_spl_token() {
    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let (mut banks_client, hyperlane_token_accounts, recipient_associated_token_account) =
        transfer_from_remote(
            initial_escrow_balance,
            remote_transfer_amount,
            None,
            None,
            spl_token::id(),
        )
        .await
        .unwrap();

    // Check that the recipient's ATA got the tokens!
    assert_token_balance(
        &mut banks_client,
        &recipient_associated_token_account,
        local_transfer_amount,
    )
    .await;

    // And that the escrow's balance is lower because it was spent in the transfer.
    assert_token_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        initial_escrow_balance - local_transfer_amount,
    )
    .await;
}

// Tests when the SPL token is the 2022 version
#[tokio::test]
async fn test_transfer_from_remote_spl_token_2022() {
    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let (mut banks_client, hyperlane_token_accounts, recipient_associated_token_account) =
        transfer_from_remote(
            initial_escrow_balance,
            remote_transfer_amount,
            None,
            None,
            spl_token_2022::id(),
        )
        .await
        .unwrap();

    // Check that the recipient's ATA got the tokens!
    assert_token_balance(
        &mut banks_client,
        &recipient_associated_token_account,
        local_transfer_amount,
    )
    .await;

    // And that the escrow's balance is lower because it was spent in the transfer.
    assert_token_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        initial_escrow_balance - local_transfer_amount,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_sender_not_router() {
    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    // Same remote domain origin, but wrong sender.
    let result = transfer_from_remote(
        initial_escrow_balance,
        remote_transfer_amount,
        Some(H256::random()),
        None,
        spl_token_2022::id(),
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );

    // Wrong remote domain origin, but correct sender.
    let result = transfer_from_remote(
        initial_escrow_balance,
        remote_transfer_amount,
        None,
        Some(REMOTE_DOMAIN + 1),
        spl_token_2022::id(),
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_process_authority_not_signer() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let mailbox_program_id = mailbox_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let _mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Enroll the remote router
    let remote_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    let recipient_pubkey = Pubkey::new_unique();
    let recipient: H256 = recipient_pubkey.to_bytes().into();

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_pubkey,
            &mint,
            &spl_token_2022::id(),
        );

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Try calling directly into the message handler, skipping the mailbox.
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MessageRecipientInstruction::Handle(HandleInstruction {
                origin: REMOTE_DOMAIN,
                sender: remote_router,
                message: TokenMessage::new(recipient, 12345u64.into(), vec![]).to_vec(),
            })
            .encode()
            .unwrap(),
            vec![
                // Recipient.handle accounts
                // 0. `[signer]` Mailbox process authority
                // 1. `[executable]` system_program
                // 2. `[]` hyperlane_token storage
                // 3. `[]` recipient wallet address
                // 4. `[executable]` SPL token 2022 program.
                // 5. `[executable]` SPL associated token account.
                // 6. `[writeable]` Mint account.
                // 7. `[writeable]` Recipient associated token account.
                // 8. `[writeable]` ATA payer PDA account.
                // 9. `[writeable]` Escrow account.
                AccountMeta::new_readonly(
                    hyperlane_token_accounts.mailbox_process_authority,
                    false,
                ),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(recipient_pubkey, false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                AccountMeta::new(mint, false),
                AccountMeta::new(recipient_associated_token_account, false),
                AccountMeta::new(hyperlane_token_accounts.ata_payer, false),
                AccountMeta::new(hyperlane_token_accounts.escrow, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_enroll_remote_router() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Enroll the remote router
    let remote_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    // Verify the remote router was enrolled.
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
        token.remote_routers,
        vec![(REMOTE_DOMAIN, remote_router)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_enroll_remote_router_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Use the mint authority as the payer, which has a balance but is not the owner,
    // so we expect this to fail.
    let result = enroll_remote_router(
        &mut banks_client,
        &program_id,
        &mint_authority,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        H256::random(),
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Also try using the mint authority as the payer and specifying the correct
    // owner account, but the owner isn't a signer:
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Enroll the remote router
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::EnrollRemoteRouter(RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(H256::random()),
            })
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), false),
            ],
        )],
        Some(&mint_authority.pubkey()),
        &[&mint_authority],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_set_destination_gas_configs() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Set the destination gas config
    let gas = 111222333;
    set_destination_gas_config(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        gas,
    )
    .await
    .unwrap();

    // Verify the destination gas was set.
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
        token.destination_gas,
        vec![(REMOTE_DOMAIN, gas)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_set_destination_gas_configs_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Use the non_owner as the payer, which has a balance but is not the owner,
    // so we expect this to fail.
    let gas = 111222333;
    let result = set_destination_gas_config(
        &mut banks_client,
        &program_id,
        &non_owner,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        gas,
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Also try using the non_owner as the payer and specifying the correct
    // owner account, but the owner isn't a signer:
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    // Try setting
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetDestinationGasConfigs(vec![GasRouterConfig {
                domain: REMOTE_DOMAIN,
                gas: Some(gas),
            }])
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), false),
            ],
        )],
        Some(&non_owner.pubkey()),
        &[&non_owner],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_transfer_ownership() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_owner = Some(Pubkey::new_unique());

    // Transfer ownership
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::TransferOwnership(new_owner)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the new owner is set
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.owner, new_owner);
}

#[tokio::test]
async fn test_transfer_ownership_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_owner = Some(Pubkey::new_unique());

    // Try transferring ownership using the mint authority key
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::TransferOwnership(new_owner)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mint_authority.pubkey(), true),
            ],
        )],
        Some(&mint_authority.pubkey()),
        &[&mint_authority],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_interchain_security_module() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_ism = Some(Pubkey::new_unique());

    // Set the ISM
    // Transfer ownership
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainSecurityModule(new_ism)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the new ISM is set
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_security_module, new_ism);
}

#[tokio::test]
async fn test_set_interchain_security_module_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_ism = Some(Pubkey::new_unique());

    // Try setting the ISM using the mint authority key
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainSecurityModule(new_ism)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mint_authority.pubkey(), true),
            ],
        )],
        Some(&mint_authority.pubkey()),
        &[&mint_authority],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Also try using the non_owner as the payer and specifying the correct
    // owner account, but the owner isn't a signer:
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainSecurityModule(new_ism)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), false),
            ],
        )],
        Some(&mint_authority.pubkey()),
        &[&mint_authority],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_set_interchain_gas_paymaster() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_igp = Some((
        Pubkey::new_unique(),
        InterchainGasPaymasterType::OverheadIgp(Pubkey::new_unique()),
    ));

    // Set the IGP
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainGasPaymaster(new_igp.clone())
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        )],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the new IGP is set
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_gas_paymaster, new_igp);
}

#[tokio::test]
async fn test_set_interchain_gas_paymaster_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_collateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let (mint, _mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    let hyperlane_token_accounts = initialize_hyperlane_token(
        &program_id,
        &mut banks_client,
        &payer,
        None,
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    let new_igp = Some((
        Pubkey::new_unique(),
        InterchainGasPaymasterType::OverheadIgp(Pubkey::new_unique()),
    ));
    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Try setting the ISM using the mint authority key
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainGasPaymaster(new_igp.clone())
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(non_owner.pubkey(), true),
            ],
        )],
        Some(&non_owner.pubkey()),
        &[&non_owner],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Also try using the non_owner as the payer and specifying the correct
    // owner account, but the owner isn't a signer:
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainGasPaymaster(new_igp)
                .encode()
                .unwrap(),
            vec![
                AccountMeta::new(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(payer.pubkey(), false),
            ],
        )],
        Some(&non_owner.pubkey()),
        &[&non_owner],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}
