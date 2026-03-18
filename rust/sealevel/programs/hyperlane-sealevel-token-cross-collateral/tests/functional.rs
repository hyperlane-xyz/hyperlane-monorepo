//! Functional tests for the hyperlane-sealevel-token-cross-collateral program.
//! Tests CPI-based operations that cannot be done strictly in unit tests.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
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
    mailbox_process_authority_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds, plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_cross_collateral::{
    accounts::CrossCollateralStateAccount,
    cross_collateral_dispatch_authority_pda_seeds, cross_collateral_pda_seeds,
    instruction::{
        enroll_cross_collateral_routers_instruction, init_instruction, CrossCollateralInit,
        CrossCollateralInstruction, HandleLocal, TransferLocal, TransferRemoteTo,
    },
    processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction},
};
use hyperlane_test_utils::{
    assert_token_balance, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, transfer_lamports, IgpAccounts,
    MailboxAccounts,
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

const ONE_SOL_IN_LAMPORTS: u64 = 1_000_000_000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 8;
const LOCAL_DECIMALS_U32: u32 = LOCAL_DECIMALS as u32;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
const REMOTE_GAS_AMOUNT: u64 = 200000;
const MINT_ACCOUNT_LEN: usize = spl_token_2022::state::Mint::LEN;

fn hyperlane_sealevel_token_cross_collateral_id() -> Pubkey {
    pubkey!("CCo11atera1TokenProgram111111111111111111111")
}

fn second_cc_program_id() -> Pubkey {
    pubkey!("CCo11atera1TokenProgram222222222222222222222")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_cross_collateral_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_cross_collateral",
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

    // Second CC program instance (same processor, different program ID)
    program_test.add_program(
        "hyperlane_sealevel_token_cross_collateral",
        second_cc_program_id(),
        processor!(process_instruction),
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

struct CcTokenAccounts {
    token: Pubkey,
    token_bump: u8,
    mailbox_process_authority: Pubkey,
    dispatch_authority: Pubkey,
    dispatch_authority_bump: u8,
    escrow: Pubkey,
    escrow_bump: u8,
    ata_payer: Pubkey,
    ata_payer_bump: u8,
    cc_state: Pubkey,
    cc_dispatch_authority: Pubkey,
}

async fn initialize_cc_token(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_accounts: Option<&IgpAccounts>,
    mint: &Pubkey,
    spl_token_program: &Pubkey,
) -> Result<CcTokenAccounts, BanksClientError> {
    let mailbox_program_id = mailbox_id();

    let (mailbox_process_authority_key, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(program_id),
        &mailbox_program_id,
    );

    let (token_account_key, token_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

    let (dispatch_authority_key, dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);

    let (escrow_account_key, escrow_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), program_id);

    let (ata_payer_account_key, ata_payer_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);

    let (cc_state_key, _) = Pubkey::find_program_address(cross_collateral_pda_seeds!(), program_id);

    let (cc_dispatch_authority_key, _) =
        Pubkey::find_program_address(cross_collateral_dispatch_authority_pda_seeds!(), program_id);

    let init = CrossCollateralInit {
        mailbox: mailbox_program_id,
        interchain_security_module: None,
        interchain_gas_paymaster: igp_accounts.map(|igp| {
            (
                igp.program,
                InterchainGasPaymasterType::OverheadIgp(igp.overhead_igp),
            )
        }),
        decimals: LOCAL_DECIMALS,
        remote_decimals: REMOTE_DECIMALS,
        local_domain: LOCAL_DOMAIN,
    };

    let ixn =
        init_instruction(*program_id, payer.pubkey(), init, *spl_token_program, *mint).unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    // Set destination gas configs if IGP is configured
    if igp_accounts.is_some() {
        set_destination_gas_config(
            banks_client,
            program_id,
            payer,
            &token_account_key,
            REMOTE_DOMAIN,
            REMOTE_GAS_AMOUNT,
        )
        .await?;
    }

    Ok(CcTokenAccounts {
        token: token_account_key,
        token_bump: token_account_bump_seed,
        mailbox_process_authority: mailbox_process_authority_key,
        dispatch_authority: dispatch_authority_key,
        dispatch_authority_bump,
        escrow: escrow_account_key,
        escrow_bump: escrow_account_bump_seed,
        ata_payer: ata_payer_account_key,
        ata_payer_bump: ata_payer_account_bump_seed,
        cc_state: cc_state_key,
        cc_dispatch_authority: cc_dispatch_authority_key,
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

async fn enroll_cc_routers(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    configs: Vec<RemoteRouterConfig>,
) -> Result<(), BanksClientError> {
    let ixn =
        enroll_cross_collateral_routers_instruction(*program_id, payer.pubkey(), configs).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(())
}

async fn unenroll_cc_routers(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    configs: Vec<RemoteRouterConfig>,
) -> Result<(), BanksClientError> {
    use hyperlane_sealevel_token_cross_collateral::instruction::unenroll_cross_collateral_routers_instruction;
    let ixn = unenroll_cross_collateral_routers_instruction(*program_id, payer.pubkey(), configs)
        .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(())
}

/// Shared test context: client + mailbox + optional IGP + mint + CC token.
struct TestContext {
    banks_client: BanksClient,
    payer: Keypair,
    program_id: Pubkey,
    mailbox_program_id: Pubkey,
    spl_token_program_id: Pubkey,
    mailbox_accounts: MailboxAccounts,
    igp_accounts: Option<IgpAccounts>,
    mint: Pubkey,
    mint_authority: Keypair,
    cc: CcTokenAccounts,
}

impl TestContext {
    async fn new(with_igp: bool) -> Self {
        let program_id = hyperlane_sealevel_token_cross_collateral_id();
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

        let igp_accounts = if with_igp {
            Some(
                initialize_igp_accounts(
                    &mut banks_client,
                    &igp_program_id(),
                    &payer,
                    REMOTE_DOMAIN,
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };

        let (mint, mint_authority) = initialize_mint(
            &mut banks_client,
            &payer,
            LOCAL_DECIMALS,
            &spl_token_program_id,
        )
        .await;

        let cc = initialize_cc_token(
            &program_id,
            &mut banks_client,
            &payer,
            igp_accounts.as_ref(),
            &mint,
            &spl_token_program_id,
        )
        .await
        .unwrap();

        Self {
            banks_client,
            payer,
            program_id,
            mailbox_program_id,
            spl_token_program_id,
            mailbox_accounts,
            igp_accounts,
            mint,
            mint_authority,
            cc,
        }
    }

    async fn init_second_cc_token(&mut self) -> CcTokenAccounts {
        initialize_cc_token(
            &second_cc_program_id(),
            &mut self.banks_client,
            &self.payer,
            None,
            &self.mint,
            &self.spl_token_program_id,
        )
        .await
        .unwrap()
    }

    async fn create_funded_sender(&mut self, token_amount: u64) -> (Keypair, Pubkey) {
        let sender =
            new_funded_keypair(&mut self.banks_client, &self.payer, ONE_SOL_IN_LAMPORTS).await;
        let sender_pubkey = sender.pubkey();
        let sender_ata = create_and_mint_to_ata(
            &mut self.banks_client,
            &self.spl_token_program_id,
            &self.mint,
            &self.mint_authority,
            &self.payer,
            &sender_pubkey,
            token_amount,
        )
        .await;
        (sender, sender_ata)
    }

    async fn fund_escrow_and_ata_payer(&mut self, escrow: Pubkey, ata_payer: Pubkey, amount: u64) {
        mint_to(
            &mut self.banks_client,
            &self.spl_token_program_id,
            &self.mint,
            &self.mint_authority,
            &escrow,
            amount,
        )
        .await;
        transfer_lamports(
            &mut self.banks_client,
            &self.payer,
            &ata_payer,
            ONE_SOL_IN_LAMPORTS,
        )
        .await;
    }
}

/// Minimal env for init-failure tests (no CC token).
struct SetupEnv {
    banks_client: BanksClient,
    payer: Keypair,
    program_id: Pubkey,
    mailbox_program_id: Pubkey,
    spl_token_program_id: Pubkey,
    mint: Pubkey,
    mint_authority: Keypair,
}

async fn setup_env() -> SetupEnv {
    let program_id = hyperlane_sealevel_token_cross_collateral_id();
    let mailbox_program_id = mailbox_id();
    let spl_token_program_id = spl_token_2022::id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_mailbox(
        &mut banks_client,
        &mailbox_program_id,
        &payer,
        LOCAL_DOMAIN,
        ONE_SOL_IN_LAMPORTS,
        ProtocolFee::default(),
    )
    .await
    .unwrap();

    let (mint, mint_authority) = initialize_mint(
        &mut banks_client,
        &payer,
        LOCAL_DECIMALS,
        &spl_token_program_id,
    )
    .await;

    SetupEnv {
        banks_client,
        payer,
        program_id,
        mailbox_program_id,
        spl_token_program_id,
        mint,
        mint_authority,
    }
}

mod init_instruction {
    use super::*;

    #[tokio::test]
    async fn test_initialize() {
        let mut ctx = TestContext::new(true).await;
        let igp = ctx.igp_accounts.as_ref().unwrap();
        let igp_program = igp.program;
        let igp_overhead_igp = igp.overhead_igp;

        // Verify token PDA state
        let token_account_data = ctx
            .banks_client
            .get_account(ctx.cc.token)
            .await
            .unwrap()
            .unwrap()
            .data;
        let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account_data[..])
            .unwrap()
            .into_inner();

        assert_eq!(token.bump, ctx.cc.token_bump);
        assert_eq!(token.mailbox, ctx.mailbox_program_id);
        assert_eq!(
            token.mailbox_process_authority,
            ctx.cc.mailbox_process_authority
        );
        assert_eq!(
            token.dispatch_authority_bump,
            ctx.cc.dispatch_authority_bump
        );
        assert_eq!(token.decimals, LOCAL_DECIMALS);
        assert_eq!(token.remote_decimals, REMOTE_DECIMALS);
        assert_eq!(token.owner, Some(ctx.payer.pubkey()));
        assert_eq!(token.interchain_security_module, None);
        assert_eq!(
            token.interchain_gas_paymaster,
            Some((
                igp_program,
                InterchainGasPaymasterType::OverheadIgp(igp_overhead_igp),
            ))
        );
        assert_eq!(token.plugin_data.mint, ctx.mint);
        assert_eq!(token.plugin_data.escrow, ctx.cc.escrow);
        assert_eq!(token.plugin_data.escrow_bump, ctx.cc.escrow_bump);
        assert_eq!(token.plugin_data.ata_payer_bump, ctx.cc.ata_payer_bump);

        // Verify CC state PDA
        let cc_state_data = ctx
            .banks_client
            .get_account(ctx.cc.cc_state)
            .await
            .unwrap()
            .unwrap()
            .data;
        let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
            .unwrap()
            .into_inner();

        assert_eq!(cc_state.local_domain, LOCAL_DOMAIN);
        assert!(cc_state.enrolled_routers.is_empty());

        // Verify CC dispatch authority PDA was created
        let cc_dispatch_authority_account = ctx
            .banks_client
            .get_account(ctx.cc.cc_dispatch_authority)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cc_dispatch_authority_account.owner, ctx.program_id);

        // Verify escrow account was created
        let escrow_account = ctx
            .banks_client
            .get_account(ctx.cc.escrow)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(escrow_account.owner, spl_token_2022::id());
        assert!(!escrow_account.data.is_empty());

        // Verify ATA payer was created
        let ata_payer_account = ctx
            .banks_client
            .get_account(ctx.cc.ata_payer)
            .await
            .unwrap()
            .unwrap();
        assert!(ata_payer_account.lamports > 0);
    }

    #[tokio::test]
    async fn test_double_init_rejected() {
        let mut env = setup_env().await;

        initialize_cc_token(
            &env.program_id,
            &mut env.banks_client,
            &env.payer,
            None,
            &env.mint,
            &env.spl_token_program_id,
        )
        .await
        .unwrap();

        // Second init should fail with AccountAlreadyInitialized
        let result = initialize_cc_token(
            &env.program_id,
            &mut env.banks_client,
            &env.mint_authority,
            None,
            &env.mint,
            &env.spl_token_program_id,
        )
        .await;

        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
        );
    }

    #[tokio::test]
    async fn test_base_init_rejected() {
        // TokenIxn::Init must return Custom(4) = BaseInitNotAllowed.
        let mut env = setup_env().await;

        let (token_account_key, _) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &env.program_id);
        let (dispatch_authority_key, _) = Pubkey::find_program_address(
            mailbox_message_dispatch_authority_pda_seeds!(),
            &env.program_id,
        );
        let (escrow_account_key, _) =
            Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), &env.program_id);
        let (ata_payer_account_key, _) =
            Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), &env.program_id);

        let recent_blockhash = env.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                env.program_id,
                &HyperlaneTokenInstruction::Init(Init {
                    mailbox: env.mailbox_program_id,
                    interchain_security_module: None,
                    interchain_gas_paymaster: None,
                    decimals: LOCAL_DECIMALS,
                    remote_decimals: REMOTE_DECIMALS,
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(token_account_key, false),
                    AccountMeta::new(dispatch_authority_key, false),
                    AccountMeta::new_readonly(env.payer.pubkey(), true),
                    AccountMeta::new_readonly(env.spl_token_program_id, false),
                    AccountMeta::new_readonly(env.mint, false),
                    AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
                    AccountMeta::new(escrow_account_key, false),
                    AccountMeta::new(ata_payer_account_key, false),
                ],
            )],
            Some(&env.payer.pubkey()),
            &[&env.payer],
            recent_blockhash,
        );
        let result = env.banks_client.process_transaction(transaction).await;

        // Custom(4) = Error::BaseInitNotAllowed
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(4)),
        );
    }

    #[tokio::test]
    async fn test_init_wrong_local_domain() {
        let mut env = setup_env().await;

        let init = CrossCollateralInit {
            mailbox: env.mailbox_program_id,
            interchain_security_module: None,
            interchain_gas_paymaster: None,
            decimals: LOCAL_DECIMALS,
            remote_decimals: REMOTE_DECIMALS,
            local_domain: 9999,
        };

        let ixn = init_instruction(
            env.program_id,
            env.payer.pubkey(),
            init,
            env.spl_token_program_id,
            env.mint,
        )
        .unwrap();

        let recent_blockhash = env.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[ixn],
            Some(&env.payer.pubkey()),
            &[&env.payer],
            recent_blockhash,
        );
        let result = env.banks_client.process_transaction(transaction).await;

        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_init_extraneous_accounts() {
        let mut env = setup_env().await;

        let init = CrossCollateralInit {
            mailbox: env.mailbox_program_id,
            interchain_security_module: None,
            interchain_gas_paymaster: None,
            decimals: LOCAL_DECIMALS,
            remote_decimals: REMOTE_DECIMALS,
            local_domain: LOCAL_DOMAIN,
        };

        let mut ixn = init_instruction(
            env.program_id,
            env.payer.pubkey(),
            init,
            env.spl_token_program_id,
            env.mint,
        )
        .unwrap();

        ixn.accounts
            .push(AccountMeta::new_readonly(Pubkey::new_unique(), false));

        let recent_blockhash = env.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[ixn],
            Some(&env.payer.pubkey()),
            &[&env.payer],
            recent_blockhash,
        );
        let result = env.banks_client.process_transaction(transaction).await;

        // Custom(1) = Error::ExtraneousAccount
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1)),
        );
    }
}

mod base_token {
    use super::*;

    #[tokio::test]
    async fn test_base_token_operations_still_work() {
        let mut ctx = TestContext::new(false).await;

        let remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            remote_router,
        )
        .await
        .unwrap();

        let token_account_data = ctx
            .banks_client
            .get_account(ctx.cc.token)
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
    async fn test_base_transfer_remote_passthrough() {
        let mut ctx = TestContext::new(true).await;
        let igp = ctx.igp_accounts.as_ref().unwrap();
        let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
            (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

        let base_remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            base_remote_router,
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 15 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );
        let (gas_payment_pda_key, _) = Pubkey::find_program_address(
            igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &igp_program_id(),
        );

        let remote_token_recipient = H256::random();

        use hyperlane_sealevel_token_lib::instruction::TransferRemote;
        let ixn_data = HyperlaneTokenInstruction::TransferRemote(TransferRemote {
            destination_domain: REMOTE_DOMAIN,
            recipient: remote_token_recipient,
            amount_or_id: transfer_amount.into(),
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        ctx.banks_client
            .process_transaction(transaction)
            .await
            .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            85 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;

        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;
    }
}

mod routers_management {
    use super::*;

    mod cc_enroll_instruction {
        use super::*;

        #[tokio::test]
        async fn test_set_cc_routers_enroll() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();

            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router_a),
                    },
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router_b),
                    },
                ],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            let routers_for_domain = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert!(routers_for_domain.contains(&router_a));
            assert!(routers_for_domain.contains(&router_b));
            assert_eq!(routers_for_domain.len(), 2);
        }

        #[tokio::test]
        async fn test_set_cc_routers_wrong_signer() {
            let mut ctx = TestContext::new(false).await;

            let non_owner =
                new_funded_keypair(&mut ctx.banks_client, &ctx.payer, ONE_SOL_IN_LAMPORTS).await;

            let result = enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &non_owner,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(H256::random()),
                }],
            )
            .await;

            assert_transaction_error(
                result,
                TransactionError::InstructionError(0, InstructionError::InvalidArgument),
            );
        }

        #[tokio::test]
        async fn test_enroll_cc_routers_owner_not_signer() {
            let mut ctx = TestContext::new(false).await;

            let ixn_data = CrossCollateralInstruction::EnrollCrossCollateralRouters(vec![
                RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(H256::random()),
                },
            ])
            .encode()
            .unwrap();

            let fake_payer =
                new_funded_keypair(&mut ctx.banks_client, &ctx.payer, ONE_SOL_IN_LAMPORTS).await;

            let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
            let transaction = Transaction::new_signed_with_payer(
                &[Instruction::new_with_bytes(
                    ctx.program_id,
                    &ixn_data,
                    vec![
                        AccountMeta::new_readonly(system_program::ID, false),
                        AccountMeta::new(ctx.cc.cc_state, false),
                        AccountMeta::new_readonly(ctx.cc.token, false),
                        // Owner's pubkey but NOT a signer
                        AccountMeta::new_readonly(ctx.payer.pubkey(), false),
                    ],
                )],
                Some(&fake_payer.pubkey()),
                &[&fake_payer],
                recent_blockhash,
            );
            let result = ctx.banks_client.process_transaction(transaction).await;

            assert_transaction_error(
                result,
                TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
            );
        }

        #[tokio::test]
        async fn test_enroll_cc_routers_idempotent() {
            let mut ctx = TestContext::new(false).await;

            let router = H256::random();

            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router),
                    },
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router),
                    },
                ],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            let routers_for_domain = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert_eq!(routers_for_domain.len(), 1);
            assert!(routers_for_domain.contains(&router));

            // Enroll the same router again in a separate transaction
            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router),
                }],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            let routers_for_domain = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert_eq!(routers_for_domain.len(), 1);
        }
    }

    mod cc_unenroll_instruction {
        use super::*;

        #[tokio::test]
        async fn test_set_cc_routers_unenroll() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();

            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_a),
                }],
            )
            .await
            .unwrap();

            unenroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                }],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            assert!(!cc_state.enrolled_routers.contains_key(&REMOTE_DOMAIN));
        }

        #[tokio::test]
        async fn test_unenroll_cc_routers_single_router() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();

            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router_a),
                    },
                    RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: Some(router_b),
                    },
                ],
            )
            .await
            .unwrap();

            unenroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_a),
                }],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            let routers = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert!(!routers.contains(&router_a));
            assert!(routers.contains(&router_b));
        }

        #[tokio::test]
        async fn test_unenroll_cc_routers_removes_domain_when_empty() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();

            enroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_a),
                }],
            )
            .await
            .unwrap();

            unenroll_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_a),
                }],
            )
            .await
            .unwrap();

            let cc_state_data = ctx
                .banks_client
                .get_account(ctx.cc.cc_state)
                .await
                .unwrap()
                .unwrap()
                .data;
            let cc_state = CrossCollateralStateAccount::fetch(&mut &cc_state_data[..])
                .unwrap()
                .into_inner();

            assert!(!cc_state.enrolled_routers.contains_key(&REMOTE_DOMAIN));
        }
    }
}

mod handle_instruction {
    use super::*;

    #[tokio::test]
    async fn test_handle_from_mailbox_cc_router() {
        let mut ctx = TestContext::new(false).await;
        let escrow = ctx.cc.escrow;
        let ata_payer = ctx.cc.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow, ata_payer, 100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;

        let remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            remote_router,
        )
        .await
        .unwrap();

        let cc_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(cc_router),
            }],
        )
        .await
        .unwrap();

        let recipient_pubkey = Pubkey::new_unique();
        let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
        let remote_transfer_amount = convert_decimals(
            local_transfer_amount.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap();

        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: REMOTE_DOMAIN,
            sender: cc_router,
            destination: LOCAL_DOMAIN,
            recipient: ctx.program_id.to_bytes().into(),
            body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
        };

        process(
            &mut ctx.banks_client,
            &ctx.payer,
            &ctx.mailbox_accounts,
            vec![],
            &message,
        )
        .await
        .unwrap();

        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );
        assert_token_balance(&mut ctx.banks_client, &recipient_ata, local_transfer_amount).await;
    }

    #[tokio::test]
    async fn test_handle_from_mailbox_primary_router() {
        let mut ctx = TestContext::new(false).await;
        let escrow = ctx.cc.escrow;
        let ata_payer = ctx.cc.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow, ata_payer, 100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;

        let remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            remote_router,
        )
        .await
        .unwrap();

        let recipient_pubkey = Pubkey::new_unique();
        let local_transfer_amount = 42 * 10u64.pow(LOCAL_DECIMALS_U32);
        let remote_transfer_amount = convert_decimals(
            local_transfer_amount.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap();

        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: REMOTE_DOMAIN,
            sender: remote_router,
            destination: LOCAL_DOMAIN,
            recipient: ctx.program_id.to_bytes().into(),
            body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
        };

        process(
            &mut ctx.banks_client,
            &ctx.payer,
            &ctx.mailbox_accounts,
            vec![],
            &message,
        )
        .await
        .unwrap();

        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );
        assert_token_balance(&mut ctx.banks_client, &recipient_ata, local_transfer_amount).await;
    }

    #[tokio::test]
    async fn test_handle_from_mailbox_unenrolled_router() {
        let mut ctx = TestContext::new(false).await;
        let escrow = ctx.cc.escrow;
        let ata_payer = ctx.cc.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow, ata_payer, 100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;

        let remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            remote_router,
        )
        .await
        .unwrap();

        let recipient_pubkey = Pubkey::new_unique();
        let remote_transfer_amount: U256 = 1000u64.into();
        let recipient: H256 = recipient_pubkey.to_bytes().into();

        let unenrolled_sender = H256::random();
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: REMOTE_DOMAIN,
            sender: unenrolled_sender,
            destination: LOCAL_DOMAIN,
            recipient: ctx.program_id.to_bytes().into(),
            body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
        };

        let result = process(
            &mut ctx.banks_client,
            &ctx.payer,
            &ctx.mailbox_accounts,
            vec![],
            &message,
        )
        .await;

        // Custom(2) = Error::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(2)),
        );
    }

    #[tokio::test]
    async fn test_handle_from_mailbox_cc_router_escrow_balance() {
        let mut ctx = TestContext::new(false).await;
        let initial_escrow_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
        let escrow = ctx.cc.escrow;
        let ata_payer = ctx.cc.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow, ata_payer, initial_escrow_balance)
            .await;

        let remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            remote_router,
        )
        .await
        .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &ctx.cc.escrow,
            initial_escrow_balance,
        )
        .await;

        let cc_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(cc_router),
            }],
        )
        .await
        .unwrap();

        let recipient_pubkey = Pubkey::new_unique();
        let local_transfer_amount = 25 * 10u64.pow(LOCAL_DECIMALS_U32);
        let remote_transfer_amount = convert_decimals(
            local_transfer_amount.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap();

        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: REMOTE_DOMAIN,
            sender: cc_router,
            destination: LOCAL_DOMAIN,
            recipient: ctx.program_id.to_bytes().into(),
            body: TokenMessage::new(recipient, remote_transfer_amount, vec![]).to_vec(),
        };

        process(
            &mut ctx.banks_client,
            &ctx.payer,
            &ctx.mailbox_accounts,
            vec![],
            &message,
        )
        .await
        .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &ctx.cc.escrow,
            initial_escrow_balance - local_transfer_amount,
        )
        .await;

        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );
        assert_token_balance(&mut ctx.banks_client, &recipient_ata, local_transfer_amount).await;
    }
}

mod handle_local_instruction {
    use super::*;

    #[tokio::test]
    async fn test_handle_local_rejects_without_valid_signer() {
        let mut ctx = TestContext::new(false).await;

        let local_cc_router = H256::from([7u8; 32]);
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(local_cc_router),
            }],
        )
        .await
        .unwrap();

        let fake_sender_program_id = Pubkey::new_unique();

        let recipient_pubkey = Pubkey::new_unique();
        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );

        let handle_local = HandleLocal {
            sender_program_id: fake_sender_program_id,
            origin: LOCAL_DOMAIN,
            message: TokenMessage::new(recipient, 1000u64.into(), vec![]).to_vec(),
        };

        let ixn_data = CrossCollateralInstruction::HandleLocal(handle_local)
            .encode()
            .unwrap();

        // Wrong signer (payer instead of derived PDA) → InvalidDispatchAuthority
        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(recipient_pubkey, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(recipient_ata, false),
                    AccountMeta::new(ctx.cc.ata_payer, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(3) = Error::InvalidDispatchAuthority
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(3)),
        );
    }

    #[tokio::test]
    async fn test_handle_local_pda_signer_required() {
        // Correct PDA key but NOT a signer → MissingRequiredSignature
        let mut ctx = TestContext::new(false).await;

        let handle_local = HandleLocal {
            sender_program_id: ctx.program_id,
            origin: LOCAL_DOMAIN,
            message: TokenMessage::new(H256::random(), 1000u64.into(), vec![]).to_vec(),
        };

        let ixn_data = CrossCollateralInstruction::HandleLocal(handle_local)
            .encode()
            .unwrap();

        let recipient_pubkey = Pubkey::new_unique();
        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(recipient_pubkey, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(recipient_ata, false),
                    AccountMeta::new(ctx.cc.ata_payer, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
        );
    }

    #[tokio::test]
    async fn test_handle_local_rejects_unenrolled_sender() {
        // A calls B.HandleLocal via TransferLocal, but A is NOT enrolled in B's CC state.
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let cc_b = ctx.init_second_cc_token().await;

        // Enroll B in A's CC state (so A can call TransferLocal targeting B)
        let router_b = H256::from(program_b.to_bytes());
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(router_b),
            }],
        )
        .await
        .unwrap();

        // Do NOT enroll A in B's CC state

        // Fund B's escrow and ATA payer
        let escrow_b = cc_b.escrow;
        let ata_payer_b = cc_b.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow_b, ata_payer_b, 100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let recipient_pubkey = Pubkey::new_unique();
        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );

        let ixn_data = CrossCollateralInstruction::TransferLocal(TransferLocal {
            recipient,
            amount_or_id: transfer_amount.into(),
            target_router: router_b,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    AccountMeta::new_readonly(program_b, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                    // B's HandleLocal accounts
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(cc_b.token, false),
                    AccountMeta::new_readonly(cc_b.cc_state, false),
                    AccountMeta::new_readonly(recipient_pubkey, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(recipient_ata, false),
                    AccountMeta::new(cc_b.ata_payer, false),
                    AccountMeta::new(cc_b.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(2) = Error::UnauthorizedRouter — B rejects A
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(2)),
        );
    }

    #[tokio::test]
    async fn test_transfer_local_same_chain() {
        // A.TransferLocal escrows in A, CPIs into B.HandleLocal which releases from B.
        let mut ctx = TestContext::new(false).await;
        let program_a = ctx.program_id;
        let program_b = second_cc_program_id();
        let cc_b = ctx.init_second_cc_token().await;

        // Mutual enrollment
        let router_b = H256::from(program_b.to_bytes());
        let router_a = H256::from(program_a.to_bytes());
        enroll_cc_routers(
            &mut ctx.banks_client,
            &program_a,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(router_b),
            }],
        )
        .await
        .unwrap();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &program_b,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(router_a),
            }],
        )
        .await
        .unwrap();

        // Fund B's escrow and ATA payer
        let escrow_b_amount = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
        let escrow_b = cc_b.escrow;
        let ata_payer_b = cc_b.ata_payer;
        ctx.fund_escrow_and_ata_payer(escrow_b, ata_payer_b, escrow_b_amount)
            .await;

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 25 * 10u64.pow(LOCAL_DECIMALS_U32);

        let recipient_pubkey = Pubkey::new_unique();
        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let recipient_ata =
            spl_associated_token_account::get_associated_token_address_with_program_id(
                &recipient_pubkey,
                &ctx.mint,
                &ctx.spl_token_program_id,
            );

        let ixn_data = CrossCollateralInstruction::TransferLocal(TransferLocal {
            recipient,
            amount_or_id: transfer_amount.into(),
            target_router: router_b,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_a,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    AccountMeta::new_readonly(program_b, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                    // B's HandleLocal accounts
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(cc_b.token, false),
                    AccountMeta::new_readonly(cc_b.cc_state, false),
                    AccountMeta::new_readonly(recipient_pubkey, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(recipient_ata, false),
                    AccountMeta::new(cc_b.ata_payer, false),
                    AccountMeta::new(cc_b.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        ctx.banks_client
            .process_transaction(transaction)
            .await
            .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            25 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;
        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;
        assert_token_balance(
            &mut ctx.banks_client,
            &cc_b.escrow,
            escrow_b_amount - transfer_amount,
        )
        .await;
        assert_token_balance(&mut ctx.banks_client, &recipient_ata, transfer_amount).await;
    }

    #[tokio::test]
    async fn test_transfer_local_rejects_unenrolled_target() {
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let router_b = H256::from(program_b.to_bytes());
        // Do NOT enroll B — target is unenrolled

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferLocal(TransferLocal {
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: router_b,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    AccountMeta::new_readonly(program_b, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(2) = Error::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(2)),
        );
    }

    #[tokio::test]
    async fn test_transfer_local_rejects_wrong_dispatch_authority() {
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let router_b = H256::from(program_b.to_bytes());

        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(router_b),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferLocal(TransferLocal {
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: router_b,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    // Wrong: payer instead of CC dispatch authority
                    AccountMeta::new_readonly(ctx.payer.pubkey(), false),
                    AccountMeta::new_readonly(program_b, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(3) = Error::InvalidDispatchAuthority
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(3)),
        );
    }

    #[tokio::test]
    async fn test_transfer_local_rejects_target_program_mismatch() {
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let router_b = H256::from(program_b.to_bytes());

        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(router_b),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferLocal(TransferLocal {
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: router_b,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    // Wrong: program_a instead of program_b
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }
}

mod transfer_remote_to_instruction {
    use super::*;

    #[tokio::test]
    async fn test_transfer_remote_to_cross_chain() {
        let mut ctx = TestContext::new(true).await;
        let igp = ctx.igp_accounts.as_ref().unwrap();
        let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
            (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

        let target_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(target_router),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );
        let (gas_payment_pda_key, _) = Pubkey::find_program_address(
            igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &igp_program_id(),
        );

        let remote_token_recipient = H256::random();
        let remote_transfer_amount =
            convert_decimals(transfer_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: REMOTE_DOMAIN,
            recipient: remote_token_recipient,
            amount_or_id: transfer_amount.into(),
            target_router,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        let tx_signature = transaction.signatures[0];
        ctx.banks_client
            .process_transaction(transaction)
            .await
            .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            31 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;
        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;

        let dispatched_message_account_data = ctx
            .banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .unwrap()
            .data;
        let dispatched_message =
            DispatchedMessageAccount::fetch(&mut &dispatched_message_account_data[..])
                .unwrap()
                .into_inner();

        let tx_status = ctx
            .banks_client
            .get_transaction_status(tx_signature)
            .await
            .unwrap()
            .unwrap();

        let expected_message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: LOCAL_DOMAIN,
            sender: ctx.program_id.to_bytes().into(),
            destination: REMOTE_DOMAIN,
            recipient: target_router,
            body: TokenMessage::new(remote_token_recipient, remote_transfer_amount, vec![])
                .to_vec(),
        };

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
        let mut ctx = TestContext::new(false).await;
        let unenrolled_target = H256::random();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: REMOTE_DOMAIN,
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: unenrolled_target,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(2) = Error::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(2)),
        );
    }

    #[tokio::test]
    async fn test_transfer_remote_to_rejects_same_chain() {
        let mut ctx = TestContext::new(false).await;

        let local_cc_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: LOCAL_DOMAIN,
                router: Some(local_cc_router),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: local_cc_router,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(5) = Error::InvalidDomain
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(5)),
        );
    }

    #[tokio::test]
    async fn test_transfer_remote_to_with_base_router_as_target() {
        let mut ctx = TestContext::new(true).await;
        let igp = ctx.igp_accounts.as_ref().unwrap();
        let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
            (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

        let base_remote_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            base_remote_router,
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );
        let (gas_payment_pda_key, _) = Pubkey::find_program_address(
            igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &igp_program_id(),
        );

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: REMOTE_DOMAIN,
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router: base_remote_router,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        ctx.banks_client
            .process_transaction(transaction)
            .await
            .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            90 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;
        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;
    }

    #[tokio::test]
    async fn test_transfer_remote_to_extraneous_accounts() {
        let mut ctx = TestContext::new(false).await;

        let target_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(target_router),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: REMOTE_DOMAIN,
            recipient: H256::random(),
            amount_or_id: transfer_amount.into(),
            target_router,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                    // Extraneous account
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // Custom(1) = Error::ExtraneousAccount
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1)),
        );
    }

    #[tokio::test]
    async fn test_transfer_remote_to_cross_chain_no_igp() {
        let mut ctx = TestContext::new(false).await;

        let target_router = H256::random();
        enroll_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![RemoteRouterConfig {
                domain: REMOTE_DOMAIN,
                router: Some(target_router),
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 20 * 10u64.pow(LOCAL_DECIMALS_U32);

        let unique_message_account_keypair = Keypair::new();
        let (dispatched_message_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
            &ctx.mailbox_program_id,
        );

        let remote_token_recipient = H256::random();
        let remote_transfer_amount =
            convert_decimals(transfer_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: REMOTE_DOMAIN,
            recipient: remote_token_recipient,
            amount_or_id: transfer_amount.into(),
            target_router,
        })
        .encode()
        .unwrap();

        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        );
        let tx_signature = transaction.signatures[0];
        ctx.banks_client
            .process_transaction(transaction)
            .await
            .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            80 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;
        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;

        let dispatched_message_account_data = ctx
            .banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .unwrap()
            .data;
        let dispatched_message =
            DispatchedMessageAccount::fetch(&mut &dispatched_message_account_data[..])
                .unwrap()
                .into_inner();

        let tx_status = ctx
            .banks_client
            .get_transaction_status(tx_signature)
            .await
            .unwrap()
            .unwrap();

        let expected_message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: LOCAL_DOMAIN,
            sender: ctx.program_id.to_bytes().into(),
            destination: REMOTE_DOMAIN,
            recipient: target_router,
            body: TokenMessage::new(remote_token_recipient, remote_transfer_amount, vec![])
                .to_vec(),
        };

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
}
