//! Functional tests for the multicollateral token program.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::{accounts::InterchainGasPaymasterType, igp_gas_payment_pda_seeds};
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessage, DispatchedMessageAccount},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds, plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction},
};
use hyperlane_sealevel_token_multicollateral::{
    instruction::{
        enroll_multi_routers_instruction, unenroll_multi_routers_instruction, EnrolledRouterConfig,
        MultiCollateralInstruction, TransferRemoteTo,
    },
    multicollateral_pda_seeds,
    processor::{process_instruction, MultiCollateralState, MultiCollateralStateAccount},
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

const ONE_SOL_IN_LAMPORTS: u64 = 1000000000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 8;
const LOCAL_DECIMALS_U32: u32 = LOCAL_DECIMALS as u32;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
const REMOTE_GAS_AMOUNT: u64 = 200000;
const MINT_ACCOUNT_LEN: usize = spl_token_2022::state::Mint::LEN;

fn hyperlane_sealevel_token_multicollateral_id() -> Pubkey {
    pubkey!("3MzUPjP5LEkiHH5ex4DkVCnGjJNaEQauEWRVLVCEHaRu")
}

/// Second program ID for same-chain CPI tests.
fn hyperlane_sealevel_token_multicollateral_id_2() -> Pubkey {
    pubkey!("8gDKnJcW2qWz1FfXJPKbxKfLDpqZrfAJmPVUb5RTdZjV")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_multicollateral",
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

    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

/// Setup with two multicollateral programs for same-chain CPI tests.
async fn setup_client_two_programs() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let program_id_2 = hyperlane_sealevel_token_multicollateral_id_2();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_multicollateral",
        program_id,
        processor!(process_instruction),
    );

    // Second multicollateral program.
    program_test.add_program(
        "hyperlane_sealevel_token_multicollateral_2",
        program_id_2,
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

    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

async fn set_local_domain(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    domain: u32,
) -> Result<(), BanksClientError> {
    let (token_key, _) = Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
    let (mc_state_key, _) = Pubkey::find_program_address(multicollateral_pda_seeds!(), program_id);

    let ixn = MultiCollateralInstruction::SetLocalDomain(domain);
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            *program_id,
            &ixn.encode().unwrap(),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(token_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(mc_state_key, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(())
}

async fn initialize_mint(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    decimals: u8,
    spl_token_program: &Pubkey,
) -> (Pubkey, Keypair) {
    let mint_authority = Keypair::new();
    transfer_lamports(
        banks_client,
        payer,
        &mint_authority.pubkey(),
        ONE_SOL_IN_LAMPORTS * 10,
    )
    .await;

    let mint_account = Keypair::new();
    let rent = Rent::default();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &payer.pubkey(),
                &mint_account.pubkey(),
                rent.minimum_balance(MINT_ACCOUNT_LEN),
                MINT_ACCOUNT_LEN as u64,
                spl_token_program,
            ),
            initialize_mint2(
                spl_token_program,
                &mint_account.pubkey(),
                &mint_authority.pubkey(),
                None,
                decimals,
            )
            .unwrap(),
        ],
        Some(&payer.pubkey()),
        &[payer, &mint_account],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    (mint_account.pubkey(), mint_authority)
}

async fn mint_to(
    banks_client: &mut BanksClient,
    spl_token_program: &Pubkey,
    mint: &Pubkey,
    mint_authority: &Keypair,
    to: &Pubkey,
    amount: u64,
) {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[spl_token_2022::instruction::mint_to(
            spl_token_program,
            mint,
            to,
            &mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
        Some(&mint_authority.pubkey()),
        &[mint_authority],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
}

struct HyperlaneTokenAccounts {
    token: Pubkey,
    token_bump: u8,
    dispatch_authority: Pubkey,
    escrow: Pubkey,
    ata_payer: Pubkey,
    mc_state: Pubkey,
    mc_state_bump: u8,
}

async fn initialize_hyperlane_token(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_accounts: Option<&IgpAccounts>,
    mint: &Pubkey,
    spl_token_program: &Pubkey,
) -> Result<HyperlaneTokenAccounts, BanksClientError> {
    let (token_account_key, token_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

    let (dispatch_authority_key, _dispatch_authority_seed) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);

    let (escrow_account_key, _escrow_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), program_id);

    let (ata_payer_account_key, _ata_payer_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);

    let (mc_state_key, mc_state_bump) =
        Pubkey::find_program_address(multicollateral_pda_seeds!(), program_id);

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
                // 4. `[executable]` The SPL token program.
                // 5. `[]` The mint.
                // 6. `[executable]` The Rent sysvar program.
                // 7. `[writable]` The escrow PDA account.
                // 8. `[writable]` The ATA payer PDA account.
                // 9. `[writable]` The multicollateral state PDA account.
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(token_account_key, false),
                AccountMeta::new(dispatch_authority_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(*spl_token_program, false),
                AccountMeta::new(*mint, false),
                AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
                AccountMeta::new(escrow_account_key, false),
                AccountMeta::new(ata_payer_account_key, false),
                AccountMeta::new(mc_state_key, false),
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
        dispatch_authority: dispatch_authority_key,
        escrow: escrow_account_key,
        ata_payer: ata_payer_account_key,
        mc_state: mc_state_key,
        mc_state_bump,
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
                AccountMeta::new_readonly(system_program::ID, false),
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
                AccountMeta::new_readonly(system_program::ID, false),
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

async fn enroll_multi_routers(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    configs: Vec<EnrolledRouterConfig>,
) -> Result<(), BanksClientError> {
    let instruction =
        enroll_multi_routers_instruction(*program_id, payer.pubkey(), configs).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(())
}

async fn unenroll_multi_routers(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    configs: Vec<EnrolledRouterConfig>,
) -> Result<(), BanksClientError> {
    let instruction =
        unenroll_multi_routers_instruction(*program_id, payer.pubkey(), configs).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(())
}

fn get_mc_state(mc_state_data: &[u8]) -> MultiCollateralState {
    *MultiCollateralStateAccount::fetch(&mut &mc_state_data[..])
        .unwrap()
        .into_inner()
}

// ========== Tests ==========

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let _mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    // Verify token PDA state.
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.bump, hyperlane_token_accounts.token_bump);
    assert_eq!(token.decimals, LOCAL_DECIMALS);
    assert_eq!(token.remote_decimals, REMOTE_DECIMALS);
    assert_eq!(token.owner, Some(payer.pubkey()));

    // Verify escrow was created.
    let escrow_account = banks_client
        .get_account(hyperlane_token_accounts.escrow)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(escrow_account.owner, spl_token_2022::id());

    // Verify mc_state PDA was created.
    let mc_state_account_data = banks_client
        .get_account(hyperlane_token_accounts.mc_state)
        .await
        .unwrap()
        .unwrap()
        .data;
    let mc_state = get_mc_state(&mc_state_account_data);
    assert_eq!(mc_state.bump, hyperlane_token_accounts.mc_state_bump);
    assert_eq!(mc_state.local_domain, 0);
    assert!(mc_state.enrolled_routers.is_empty());
}

#[tokio::test]
async fn test_enroll_routers() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

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

    let router_a = H256::random();
    let router_b = H256::random();

    // Enroll two routers for the same domain.
    enroll_multi_routers(
        &mut banks_client,
        &program_id,
        &payer,
        vec![
            EnrolledRouterConfig {
                domain: REMOTE_DOMAIN,
                router: router_a,
            },
            EnrolledRouterConfig {
                domain: REMOTE_DOMAIN,
                router: router_b,
            },
        ],
    )
    .await
    .unwrap();

    // Verify enrolled routers.
    let mc_state_data = banks_client
        .get_account(hyperlane_token_accounts.mc_state)
        .await
        .unwrap()
        .unwrap()
        .data;
    let mc_state = get_mc_state(&mc_state_data);
    assert!(mc_state.is_enrolled(REMOTE_DOMAIN, &router_a));
    assert!(mc_state.is_enrolled(REMOTE_DOMAIN, &router_b));
    assert!(!mc_state.is_enrolled(REMOTE_DOMAIN + 1, &router_a));
}

#[tokio::test]
async fn test_unenroll_routers() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

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

    let router_a = H256::random();
    let router_b = H256::random();

    enroll_multi_routers(
        &mut banks_client,
        &program_id,
        &payer,
        vec![
            EnrolledRouterConfig {
                domain: REMOTE_DOMAIN,
                router: router_a,
            },
            EnrolledRouterConfig {
                domain: REMOTE_DOMAIN,
                router: router_b,
            },
        ],
    )
    .await
    .unwrap();

    // Unenroll router_a.
    unenroll_multi_routers(
        &mut banks_client,
        &program_id,
        &payer,
        vec![EnrolledRouterConfig {
            domain: REMOTE_DOMAIN,
            router: router_a,
        }],
    )
    .await
    .unwrap();

    let mc_state_data = banks_client
        .get_account(hyperlane_token_accounts.mc_state)
        .await
        .unwrap()
        .unwrap()
        .data;
    let mc_state = get_mc_state(&mc_state_data);
    assert!(!mc_state.is_enrolled(REMOTE_DOMAIN, &router_a));
    assert!(mc_state.is_enrolled(REMOTE_DOMAIN, &router_b));
}

#[tokio::test]
async fn test_enroll_routers_not_owner() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

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

    let (mint, _mint_authority) = initialize_mint(
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

    // Try to enroll with a non-owner.
    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let result = enroll_multi_routers(
        &mut banks_client,
        &program_id,
        &non_owner,
        vec![EnrolledRouterConfig {
            domain: REMOTE_DOMAIN,
            router: H256::random(),
        }],
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::IllegalOwner),
    );
}

#[tokio::test]
async fn test_transfer_from_remote_with_enrolled_router() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    // ATA payer must have a balance to create new ATAs.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Enroll a remote router as primary.
    let primary_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        primary_router,
    )
    .await
    .unwrap();

    // Enroll an ADDITIONAL multicollateral router.
    let mc_router = H256::random();
    enroll_multi_routers(
        &mut banks_client,
        &program_id,
        &payer,
        vec![EnrolledRouterConfig {
            domain: REMOTE_DOMAIN,
            router: mc_router,
        }],
    )
    .await
    .unwrap();

    // Fund escrow with tokens.
    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
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

    let local_transfer_amount = 50 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let recipient_ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        &recipient_pubkey,
        &mint,
        &spl_token_program_id,
    );

    // Message FROM the enrolled multicollateral router (not the primary one).
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: mc_router, // From the enrolled MC router, NOT the primary.
        destination: LOCAL_DOMAIN,
        recipient: program_id.to_bytes().into(),
        body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
    };

    // Process the message via the mailbox.
    process(
        &mut banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
    )
    .await
    .unwrap();

    // Verify recipient got tokens.
    assert_token_balance(&mut banks_client, &recipient_ata, local_transfer_amount).await;

    // Verify escrow balance decreased.
    assert_token_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        initial_escrow_balance - local_transfer_amount,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_from_remote_rejects_unenrolled_router() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Enroll a primary router.
    let primary_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        primary_router,
    )
    .await
    .unwrap();

    // Fund escrow.
    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
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

    let local_transfer_amount = 50 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    // Message from an UNENROLLED sender.
    let unenrolled_sender = H256::random();
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: unenrolled_sender,
        destination: LOCAL_DOMAIN,
        recipient: program_id.to_bytes().into(),
        body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
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
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );
}

#[tokio::test]
async fn test_transfer_from_remote_accepts_primary_router() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Enroll a primary router (NOT multicollateral).
    let primary_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        primary_router,
    )
    .await
    .unwrap();

    let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
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

    let local_transfer_amount = 50 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let recipient_ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        &recipient_pubkey,
        &mint,
        &spl_token_program_id,
    );

    // Message from the PRIMARY router (not a multicollateral one).
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: REMOTE_DOMAIN,
        sender: primary_router,
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
    .await
    .unwrap();

    assert_token_balance(&mut banks_client, &recipient_ata, local_transfer_amount).await;
}

async fn create_and_mint_to_ata(
    banks_client: &mut BanksClient,
    spl_token_program: &Pubkey,
    mint: &Pubkey,
    mint_authority: &Keypair,
    payer: &Keypair,
    wallet: &Pubkey,
    amount: u64,
) -> Pubkey {
    let ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        wallet,
        mint,
        spl_token_program,
    );

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[
            create_associated_token_account_idempotent(
                &payer.pubkey(),
                wallet,
                mint,
                spl_token_program,
            ),
            spl_token_2022::instruction::mint_to(
                spl_token_program,
                mint,
                &ata,
                &mint_authority.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
        ],
        Some(&payer.pubkey()),
        &[payer, mint_authority],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
    ata
}

#[tokio::test]
async fn test_transfer_remote_to_cross_chain() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
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

    // Enroll a primary remote router.
    let primary_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        primary_router,
    )
    .await
    .unwrap();

    // Enroll an additional multicollateral router for the same domain.
    let target_router = H256::random();
    enroll_multi_routers(
        &mut banks_client,
        &program_id,
        &payer,
        vec![EnrolledRouterConfig {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Create and fund sender.
    let token_sender = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS * 5).await;
    let token_sender_pubkey = token_sender.pubkey();
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let token_sender_ata = create_and_mint_to_ata(
        &mut banks_client,
        &spl_token_program_id,
        &mint,
        &mint_authority,
        &payer,
        &token_sender_pubkey,
        sender_initial_balance,
    )
    .await;

    // Build the TransferRemoteTo instruction.
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
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount =
        convert_decimals(transfer_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();

    let ixn = MultiCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: remote_token_recipient,
        amount_or_id: transfer_amount,
        target_router,
    });

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &ixn.encode().unwrap(),
            vec![
                // 0. System program.
                AccountMeta::new_readonly(system_program::ID, false),
                // 1. SPL Noop.
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                // 2. Token PDA.
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                // 3. Multicollateral state PDA.
                AccountMeta::new_readonly(hyperlane_token_accounts.mc_state, false),
                // 4. Mailbox program.
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                // 5. Mailbox outbox.
                AccountMeta::new(mailbox_accounts.outbox, false),
                // 6. Dispatch authority.
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                // 7. Sender wallet (signer + payer).
                AccountMeta::new(token_sender_pubkey, true),
                // 8. Unique message account (signer).
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                // 9. Dispatched message PDA.
                AccountMeta::new(dispatched_message_key, false),
                // 10. IGP program.
                AccountMeta::new_readonly(igp_accounts.program, false),
                // 11. IGP program data.
                AccountMeta::new(igp_accounts.program_data, false),
                // 12. Gas payment PDA.
                AccountMeta::new(gas_payment_pda_key, false),
                // 13. Overhead IGP.
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                // 14. IGP account.
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts:
                // 15. SPL Token program.
                AccountMeta::new_readonly(spl_token_program_id, false),
                // 16. Mint.
                AccountMeta::new(mint, false),
                // 17. Sender ATA.
                AccountMeta::new(token_sender_ata, false),
                // 18. Escrow PDA.
                AccountMeta::new(hyperlane_token_accounts.escrow, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify sender balance decreased (100 - 69 = 31).
    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        31 * 10u64.pow(LOCAL_DECIMALS_U32),
    )
    .await;

    // Verify escrow got the tokens.
    assert_token_balance(
        &mut banks_client,
        &hyperlane_token_accounts.escrow,
        69 * 10u64.pow(LOCAL_DECIMALS_U32),
    )
    .await;

    // Verify the dispatched message targets the enrolled MC router, NOT the primary.
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

    let expected_message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: LOCAL_DOMAIN,
        sender: program_id.to_bytes().into(),
        destination: REMOTE_DOMAIN,
        recipient: target_router, // Should be the MC router, NOT primary_router.
        body: TokenMessage::new(remote_token_recipient, remote_transfer_amount, vec![]).to_vec(),
    };

    let tx_status = banks_client
        .get_transaction_status(tx_signature)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        dispatched_message,
        Box::new(DispatchedMessage::new(
            expected_message.nonce,
            tx_status.slot,
            unique_message_account_keypair.pubkey(),
            expected_message.to_vec(),
        )),
    );
}

#[tokio::test]
async fn test_transfer_remote_to_rejects_unenrolled_target() {
    let program_id = hyperlane_sealevel_token_multicollateral_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    let mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    // Enroll a primary remote router only.
    let primary_router = H256::random();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hyperlane_token_accounts.token,
        REMOTE_DOMAIN,
        primary_router,
    )
    .await
    .unwrap();

    let token_sender = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS * 5).await;
    let token_sender_pubkey = token_sender.pubkey();
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

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_id(),
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    // Try to transfer to an UNENROLLED target router.
    let unenrolled_target = H256::random();
    let ixn = MultiCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: 10 * 10u64.pow(LOCAL_DECIMALS_U32),
        target_router: unenrolled_target,
    });

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &ixn.encode().unwrap(),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.mc_state, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                AccountMeta::new_readonly(spl_token_program_id, false),
                AccountMeta::new(mint, false),
                AccountMeta::new(token_sender_ata, false),
                AccountMeta::new(hyperlane_token_accounts.escrow, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );

    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );
}

#[tokio::test]
async fn test_same_chain_cpi_transfer() {
    let source_program_id = hyperlane_sealevel_token_multicollateral_id();
    let target_program_id = hyperlane_sealevel_token_multicollateral_id_2();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client_two_programs().await;

    let _mailbox_accounts = initialize_mailbox(
        &mut banks_client,
        &mailbox_id(),
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

    // Both programs share the same mint.
    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    // Initialize source program.
    let source_accounts = initialize_hyperlane_token(
        &source_program_id,
        &mut banks_client,
        &payer,
        Some(&igp_accounts),
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Initialize target program.
    let target_accounts = initialize_hyperlane_token(
        &target_program_id,
        &mut banks_client,
        &payer,
        Some(&igp_accounts),
        &mint,
        &spl_token_program_id,
    )
    .await
    .unwrap();

    // Set local domain on both.
    set_local_domain(&mut banks_client, &source_program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();
    set_local_domain(&mut banks_client, &target_program_id, &payer, LOCAL_DOMAIN)
        .await
        .unwrap();

    // Cross-enroll: source enrolls target, target enrolls source.
    let target_as_h256 = H256::from(target_program_id.to_bytes());
    let source_as_h256 = H256::from(source_program_id.to_bytes());

    enroll_multi_routers(
        &mut banks_client,
        &source_program_id,
        &payer,
        vec![EnrolledRouterConfig {
            domain: LOCAL_DOMAIN,
            router: target_as_h256,
        }],
    )
    .await
    .unwrap();

    enroll_multi_routers(
        &mut banks_client,
        &target_program_id,
        &payer,
        vec![EnrolledRouterConfig {
            domain: LOCAL_DOMAIN,
            router: source_as_h256,
        }],
    )
    .await
    .unwrap();

    // Fund target's escrow (so it has tokens to release).
    let target_initial_escrow = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    mint_to(
        &mut banks_client,
        &spl_token_program_id,
        &mint,
        &mint_authority,
        &target_accounts.escrow,
        target_initial_escrow,
    )
    .await;

    // Fund target's ATA payer.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &target_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Create and fund sender with tokens.
    let token_sender = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS * 5).await;
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let token_sender_ata = create_and_mint_to_ata(
        &mut banks_client,
        &spl_token_program_id,
        &mint,
        &mint_authority,
        &payer,
        &token_sender.pubkey(),
        sender_initial_balance,
    )
    .await;

    // Build TransferRemoteTo targeting same domain (same-chain CPI).
    let transfer_amount = 50 * 10u64.pow(LOCAL_DECIMALS_U32);
    let recipient_pubkey = Pubkey::new_unique();
    let recipient: H256 = recipient_pubkey.to_bytes().into();

    let recipient_ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        &recipient_pubkey,
        &mint,
        &spl_token_program_id,
    );

    let ixn = MultiCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: LOCAL_DOMAIN, // Same chain!
        recipient,
        amount_or_id: transfer_amount,
        target_router: target_as_h256, // Target program.
    });

    // Same-chain account layout:
    // 0. System program
    // 1. Token PDA (source)
    // 2. MC state PDA (source)
    // 3. Sender wallet (signer)
    // 4..N. Plugin transfer_in accounts (SPL token, mint, sender ATA, source escrow)
    // N+1. Target program (executable)
    // N+2..M. Target's HandleLocal accounts:
    //   - target token PDA
    //   - target mc_state PDA
    //   - recipient wallet
    //   - target plugin transfer_out accounts (SPL token, mint, target ATA payer, target escrow, recipient ATA)
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            source_program_id,
            &ixn.encode().unwrap(),
            vec![
                // 0. System program.
                AccountMeta::new_readonly(system_program::ID, false),
                // 1. SPL Noop (always present, even for same-chain).
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                // 2. Source token PDA.
                AccountMeta::new_readonly(source_accounts.token, false),
                // 3. Source MC state PDA.
                AccountMeta::new_readonly(source_accounts.mc_state, false),
                // -- Same-chain branch starts here --
                // 4. Sender wallet (signer).
                AccountMeta::new(token_sender.pubkey(), true),
                // Plugin transfer_in accounts (SPL token program, mint, sender ATA, source escrow).
                AccountMeta::new_readonly(spl_token_program_id, false),
                AccountMeta::new(mint, false),
                AccountMeta::new(token_sender_ata, false),
                AccountMeta::new(source_accounts.escrow, false),
                // Target program (executable).
                AccountMeta::new_readonly(target_program_id, false),
                // Target's HandleLocal remaining accounts:
                // target token PDA.
                AccountMeta::new_readonly(target_accounts.token, false),
                // target mc_state PDA.
                AccountMeta::new_readonly(target_accounts.mc_state, false),
                // recipient wallet.
                AccountMeta::new(recipient_pubkey, false),
                // target plugin transfer_out accounts:
                // 0. SPL token program.
                AccountMeta::new_readonly(spl_token_program_id, false),
                // 1. SPL associated token account program.
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                // 2. Mint.
                AccountMeta::new_readonly(mint, false),
                // 3. Recipient ATA.
                AccountMeta::new(recipient_ata, false),
                // 4. ATA payer PDA (target's).
                AccountMeta::new(target_accounts.ata_payer, false),
                // 5. Escrow (target's).
                AccountMeta::new(target_accounts.escrow, false),
            ],
        )],
        Some(&token_sender.pubkey()),
        &[&token_sender],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify: sender lost 50 tokens.
    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        sender_initial_balance - transfer_amount,
    )
    .await;

    // Verify: source escrow gained 50 tokens.
    assert_token_balance(&mut banks_client, &source_accounts.escrow, transfer_amount).await;

    // Verify: target escrow lost 50 tokens.
    assert_token_balance(
        &mut banks_client,
        &target_accounts.escrow,
        target_initial_escrow - transfer_amount,
    )
    .await;

    // Verify: recipient got 50 tokens.
    assert_token_balance(&mut banks_client, &recipient_ata, transfer_amount).await;
}
