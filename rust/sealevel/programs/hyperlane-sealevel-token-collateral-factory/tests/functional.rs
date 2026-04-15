//! Functional tests for the hyperlane-sealevel-token-collateral-factory program.
//! Tests the collateral (lock/unlock) factory that hosts multiple warp routes as PDAs.
//!
//! Note: `test_transfer_remote_from_route` (outbound transfer) is omitted because
//! `CollateralFactoryPlugin::transfer_in_from_route` currently delegates to the unimplemented
//! stub `transfer_in`, which returns `InvalidInstructionData`.

use hyperlane_core::{Encode, HyperlaneMessage, H256};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_mailbox::{
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds, protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_collateral_factory::{
    hyperlane_token_route_ata_payer_pda_seeds, hyperlane_token_route_escrow_pda_seeds,
    plugin::CollateralFactoryPlugin, processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{
        convert_decimals, HyperlaneTokenFactory, HyperlaneTokenFactoryAccount,
        HyperlaneTokenRouteAccount, RouterLookupAccount,
    },
    hyperlane_token_factory_state_pda_seeds, hyperlane_token_route_pda_seeds,
    hyperlane_token_router_lookup_pda_seeds,
    instruction::{
        create_route_instruction, enroll_remote_routers_for_route_instruction,
        init_factory_instruction, CreateRoute, EnrollRemoteRoutersForRoute, InitFactory,
    },
};
use hyperlane_test_utils::{
    assert_token_balance, get_account_metas, get_ism_getter_account_metas,
    get_ism_verify_account_metas, get_recipient_ism_with_account_metas, initialize_mailbox,
    mailbox_id, new_funded_keypair, process_with_accounts, transfer_lamports, MailboxAccounts,
};
use hyperlane_warp_route::TokenMessage;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
};
use solana_program_test::*;
use solana_sdk::{signature::Signer, signer::keypair::Keypair, transaction::Transaction};
use solana_system_interface::{instruction as system_instruction, program as system_program};
use spl_token_2022::instruction::initialize_mint2;

const ONE_SOL_IN_LAMPORTS: u64 = 1_000_000_000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 8;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
// spl_token_2022 mint account size (without extensions)
const MINT_ACCOUNT_LEN: usize = spl_token_2022::state::Mint::LEN;

fn factory_program_id() -> Pubkey {
    pubkey!("CwHaw8ewMyzZn9vvrZEnTkVo3UkgGVocZB37abW5wFem")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = factory_program_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_collateral_factory",
        program_id,
        processor!(process_instruction),
    );

    fn noop_processor(
        _program_id: &Pubkey,
        _accounts: &[solana_program::account_info::AccountInfo],
        _instruction_data: &[u8],
    ) -> solana_program::entrypoint::ProgramResult {
        Ok(())
    }
    program_test.add_program(
        "spl_noop",
        account_utils::SPL_NOOP_PROGRAM_ID,
        processor!(noop_processor),
    );

    program_test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_id(),
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;
    (banks_client, payer)
}

struct FactoryAccounts {
    factory_state: Pubkey,
    factory_state_bump: u8,
}

struct RouteAccounts {
    route_pda: Pubkey,
    route_pda_bump: u8,
    escrow: Pubkey,
    escrow_bump: u8,
    ata_payer: Pubkey,
    ata_payer_bump: u8,
    dispatch_authority_bump: u8,
    mailbox_process_authority: Pubkey,
}

/// Creates an spl_token_2022 mint and returns (mint_pubkey, mint_authority_keypair).
async fn initialize_spl_mint(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    decimals: u8,
) -> (Pubkey, Keypair) {
    let mint = Keypair::new();
    let mint_authority = new_funded_keypair(banks_client, payer, ONE_SOL_IN_LAMPORTS).await;

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &payer.pubkey(),
                &mint.pubkey(),
                Rent::default().minimum_balance(MINT_ACCOUNT_LEN),
                MINT_ACCOUNT_LEN.try_into().unwrap(),
                &spl_token_2022::id(),
            ),
            initialize_mint2(
                &spl_token_2022::id(),
                &mint.pubkey(),
                &mint_authority.pubkey(),
                None,
                decimals,
            )
            .unwrap(),
        ],
        Some(&payer.pubkey()),
        &[payer, &mint],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    (mint.pubkey(), mint_authority)
}

async fn init_factory(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
) -> Result<FactoryAccounts, BanksClientError> {
    let (factory_state_key, factory_state_bump) =
        Pubkey::find_program_address(hyperlane_token_factory_state_pda_seeds!(), program_id);

    let ixn = init_factory_instruction(
        *program_id,
        payer.pubkey(),
        InitFactory {
            interchain_security_module: None,
        },
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await?;

    Ok(FactoryAccounts {
        factory_state: factory_state_key,
        factory_state_bump,
    })
}

async fn create_route(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox: Pubkey,
    salt: [u8; 32],
    mint: Pubkey,
) -> Result<RouteAccounts, BanksClientError> {
    let (route_pda_key, route_pda_bump) =
        Pubkey::find_program_address(hyperlane_token_route_pda_seeds!(&salt), program_id);

    let (escrow_key, escrow_bump) =
        Pubkey::find_program_address(hyperlane_token_route_escrow_pda_seeds!(&salt), program_id);

    let (ata_payer_key, ata_payer_bump) = Pubkey::find_program_address(
        hyperlane_token_route_ata_payer_pda_seeds!(&salt),
        program_id,
    );

    let (_dispatch_authority_key, dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);

    let (mailbox_process_authority_key, _) =
        Pubkey::find_program_address(mailbox_process_authority_pda_seeds!(program_id), &mailbox);

    // Plugin accounts for CollateralFactoryPlugin::initialize_for_route:
    // 0: spl_token_program, 1: mint, 2: rent_sysvar, 3: escrow_pda (writable), 4: ata_payer_pda (writable)
    let plugin_accounts = vec![
        AccountMeta::new_readonly(spl_token_2022::id(), false),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
        AccountMeta::new(escrow_key, false),
        AccountMeta::new(ata_payer_key, false),
    ];

    let create_route_ixn = create_route_instruction(
        *program_id,
        payer.pubkey(),
        CreateRoute {
            salt,
            mailbox,
            interchain_security_module: None,
            interchain_gas_paymaster: None,
            decimals: LOCAL_DECIMALS,
            remote_decimals: REMOTE_DECIMALS,
        },
        plugin_accounts,
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[create_route_ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await?;

    Ok(RouteAccounts {
        route_pda: route_pda_key,
        route_pda_bump,
        escrow: escrow_key,
        escrow_bump,
        ata_payer: ata_payer_key,
        ata_payer_bump,
        dispatch_authority_bump,
        mailbox_process_authority: mailbox_process_authority_key,
    })
}

async fn enroll_remote_router_for_route(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: &[u8; 32],
    domain: u32,
    router: H256,
) -> Result<Pubkey, BanksClientError> {
    let origin_le = domain.to_le_bytes();
    let sender_bytes = router.as_bytes();
    let (lookup_pda_key, _) = Pubkey::find_program_address(
        hyperlane_token_router_lookup_pda_seeds!(&origin_le, sender_bytes),
        program_id,
    );

    let ixn = enroll_remote_routers_for_route_instruction(
        *program_id,
        payer.pubkey(),
        EnrollRemoteRoutersForRoute {
            salt: *salt,
            configs: vec![RemoteRouterConfig {
                domain,
                router: Some(router),
            }],
        },
        vec![lookup_pda_key],
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await?;

    Ok(lookup_pda_key)
}

/// Mints tokens directly into a token account (e.g. escrow) using an external mint authority.
async fn mint_tokens_to(
    banks_client: &mut BanksClient,
    mint: &Pubkey,
    mint_authority: &Keypair,
    destination_token_account: &Pubkey,
    amount: u64,
) {
    let ix = spl_token_2022::instruction::mint_to(
        &spl_token_2022::id(),
        mint,
        destination_token_account,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&mint_authority.pubkey()),
        &[mint_authority],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

/// Builds the full mailbox process account list for a factory program's Handle instruction.
///
/// The collateral factory uses a lookup PDA to identify the route.
/// The standard `get_handle_account_metas` expects a different first account, so we
/// simulate `HandleAccountMetas` manually with `[lookup_pda, route_pda]`.
async fn build_factory_process_accounts(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    message: &HyperlaneMessage,
    lookup_pda: Pubkey,
    route_pda: Pubkey,
) -> Vec<AccountMeta> {
    let factory_program_id: Pubkey = message.recipient.0.into();

    let mut encoded_message = vec![];
    message.write_to(&mut encoded_message).unwrap();

    let (process_authority_key, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(&factory_program_id),
        &mailbox_accounts.program,
    );
    let (processed_message_pda, _) = Pubkey::find_program_address(
        mailbox_processed_message_pda_seeds!(message.id()),
        &mailbox_accounts.program,
    );

    let ism_getter_account_metas =
        get_ism_getter_account_metas(banks_client, payer, factory_program_id)
            .await
            .unwrap();

    let ism = get_recipient_ism_with_account_metas(
        banks_client,
        payer,
        mailbox_accounts,
        factory_program_id,
        ism_getter_account_metas.clone(),
    )
    .await
    .unwrap();

    let ism_verify_account_metas =
        get_ism_verify_account_metas(banks_client, payer, ism, vec![], encoded_message)
            .await
            .unwrap();

    // Simulate HandleAccountMetas with factory-specific accounts.
    let handle_instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction {
        origin: message.origin,
        sender: message.sender,
        message: message.body.clone(),
    });
    let sim_instruction = Instruction::new_with_bytes(
        factory_program_id,
        &handle_instruction.encode().unwrap(),
        vec![
            AccountMeta::new_readonly(lookup_pda, false),
            AccountMeta::new_readonly(route_pda, false),
        ],
    );
    let handle_account_metas = get_account_metas(banks_client, payer, sim_instruction)
        .await
        .unwrap();

    let mut accounts = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(mailbox_accounts.inbox, false),
        AccountMeta::new_readonly(process_authority_key, false),
        AccountMeta::new(processed_message_pda, false),
    ];
    accounts.extend(ism_getter_account_metas);
    accounts.extend([
        AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new_readonly(ism, false),
    ]);
    accounts.extend(ism_verify_account_metas);
    accounts.extend([AccountMeta::new_readonly(factory_program_id, false)]);
    accounts.extend(handle_account_metas);

    accounts
}

#[tokio::test]
async fn test_init_factory() {
    let program_id = factory_program_id();
    let (mut banks_client, payer) = setup_client().await;

    let factory_accounts = init_factory(&program_id, &mut banks_client, &payer)
        .await
        .unwrap();

    let data = banks_client
        .get_account(factory_accounts.factory_state)
        .await
        .unwrap()
        .unwrap()
        .data;
    let factory_state = HyperlaneTokenFactoryAccount::fetch(&mut &data[..])
        .unwrap()
        .into_inner();

    assert_eq!(
        factory_state,
        Box::new(HyperlaneTokenFactory {
            bump: factory_accounts.factory_state_bump,
            owner: Some(payer.pubkey()),
            interchain_security_module: None,
        })
    );
}

#[tokio::test]
async fn test_create_route() {
    let program_id = factory_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    init_factory(&program_id, &mut banks_client, &payer)
        .await
        .unwrap();

    let (mint, _mint_authority) =
        initialize_spl_mint(&mut banks_client, &payer, LOCAL_DECIMALS).await;

    let salt = [1u8; 32];
    let route_accounts = create_route(
        &program_id,
        &mut banks_client,
        &payer,
        mailbox_id(),
        salt,
        mint,
    )
    .await
    .unwrap();

    // Verify route PDA state.
    let route_data = banks_client
        .get_account(route_accounts.route_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let route = HyperlaneTokenRouteAccount::<CollateralFactoryPlugin>::fetch(&mut &route_data[..])
        .unwrap()
        .into_inner();

    assert_eq!(route.salt, salt);
    assert_eq!(route.token.bump, route_accounts.route_pda_bump);
    assert_eq!(route.token.mailbox, mailbox_id());
    assert_eq!(route.token.owner, Some(payer.pubkey()));
    assert_eq!(route.token.decimals, LOCAL_DECIMALS);
    assert_eq!(route.token.remote_decimals, REMOTE_DECIMALS);
    assert_eq!(
        route.token.dispatch_authority_bump,
        route_accounts.dispatch_authority_bump
    );
    assert_eq!(
        route.token.mailbox_process_authority,
        route_accounts.mailbox_process_authority
    );
    assert_eq!(
        route.token.plugin_data.spl_token_program,
        spl_token_2022::id()
    );
    assert_eq!(route.token.plugin_data.mint, mint);
    assert_eq!(route.token.plugin_data.escrow, route_accounts.escrow);
    assert_eq!(
        route.token.plugin_data.escrow_bump,
        route_accounts.escrow_bump
    );
    assert_eq!(
        route.token.plugin_data.ata_payer_bump,
        route_accounts.ata_payer_bump
    );

    // Verify escrow token account was created.
    let escrow_account = banks_client
        .get_account(route_accounts.escrow)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(escrow_account.owner, spl_token_2022::id());
    assert!(!escrow_account.data.is_empty());

    // Verify ATA payer PDA was created.
    let ata_payer_account = banks_client
        .get_account(route_accounts.ata_payer)
        .await
        .unwrap()
        .unwrap();
    assert!(ata_payer_account.lamports > 0);
}

#[tokio::test]
async fn test_enroll_remote_routers_for_route() {
    let program_id = factory_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    init_factory(&program_id, &mut banks_client, &payer)
        .await
        .unwrap();

    let (mint, _mint_authority) =
        initialize_spl_mint(&mut banks_client, &payer, LOCAL_DECIMALS).await;

    let salt = [2u8; 32];
    let route_accounts = create_route(
        &program_id,
        &mut banks_client,
        &payer,
        mailbox_id(),
        salt,
        mint,
    )
    .await
    .unwrap();

    let remote_router = H256::random();
    let lookup_pda = enroll_remote_router_for_route(
        &program_id,
        &mut banks_client,
        &payer,
        &salt,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    // Verify lookup PDA points to the route PDA.
    let lookup_data = banks_client
        .get_account(lookup_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let lookup = RouterLookupAccount::fetch(&mut &lookup_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(lookup.route_pda, route_accounts.route_pda);

    // Verify route PDA remote_routers map was updated.
    let route_data = banks_client
        .get_account(route_accounts.route_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let route = HyperlaneTokenRouteAccount::<CollateralFactoryPlugin>::fetch(&mut &route_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        route.token.remote_routers.get(&REMOTE_DOMAIN),
        Some(&remote_router)
    );
}

#[tokio::test]
async fn test_transfer_from_remote_for_route() {
    let program_id = factory_program_id();
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

    init_factory(&program_id, &mut banks_client, &payer)
        .await
        .unwrap();

    let (mint, mint_authority) =
        initialize_spl_mint(&mut banks_client, &payer, LOCAL_DECIMALS).await;

    let salt = [3u8; 32];
    let route_accounts = create_route(
        &program_id,
        &mut banks_client,
        &payer,
        mailbox_program_id,
        salt,
        mint,
    )
    .await
    .unwrap();

    // Fund ATA payer so it can create ATAs for recipients.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &route_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    let remote_router = H256::random();
    let lookup_pda = enroll_remote_router_for_route(
        &program_id,
        &mut banks_client,
        &payer,
        &salt,
        REMOTE_DOMAIN,
        remote_router,
    )
    .await
    .unwrap();

    // Seed the escrow with tokens to be released on inbound transfer.
    let local_amount = 100 * 10u64.pow(LOCAL_DECIMALS as u32);
    let remote_amount =
        convert_decimals(local_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();
    mint_tokens_to(
        &mut banks_client,
        &mint,
        &mint_authority,
        &route_accounts.escrow,
        local_amount,
    )
    .await;

    let recipient_pubkey = Pubkey::new_unique();

    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: remote_router,
        destination: LOCAL_DOMAIN,
        recipient: program_id.to_bytes().into(),
        body: TokenMessage::new(recipient_pubkey.to_bytes().into(), remote_amount, vec![]).to_vec(),
    };

    let process_accounts = build_factory_process_accounts(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        &message,
        lookup_pda,
        route_accounts.route_pda,
    )
    .await;

    process_with_accounts(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
        process_accounts,
    )
    .await
    .unwrap();

    // Verify recipient ATA received the tokens from the escrow.
    let recipient_ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        &recipient_pubkey,
        &mint,
        &spl_token_2022::id(),
    );
    assert_token_balance(&mut banks_client, &recipient_ata, local_amount).await;
}
