//! Functional tests for the hyperlane-sealevel-token-cross-collateral program.
//! Tests CPI-based operations that cannot be done strictly in unit tests.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use hyperlane_sealevel_fee::{
    accounts::{FeeData, LeafFeeConfig, WILDCARD_DOMAIN},
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    fee_standing_quote_pda_seeds, instruction as fee_instruction,
    processor::process_instruction as fee_process_instruction,
};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

use borsh::BorshDeserialize;
use hyperlane_core::{Decode, H160};
use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::{
    accounts::{
        GasPaymentAccount, IgpFeeConfig, InterchainGasPaymasterType, TOKEN_EXCHANGE_RATE_SCALE,
    },
    igp_gas_payment_pda_seeds, igp_standing_quote_pda_seeds, igp_transient_quote_pda_seeds,
    instruction::{
        set_igp_quote_config_instruction, set_igp_quote_signer_instruction,
        submit_igp_quote_instruction, SetIgpQuoteSignerOperation,
    },
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
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds, plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_cross_collateral::{
    accounts::CrossCollateralStateAccount,
    cross_collateral_dispatch_authority_pda_seeds, cross_collateral_pda_seeds,
    instruction::{
        init_instruction, set_cross_collateral_routers_instruction, CrossCollateralInstruction,
        CrossCollateralRouterUpdate, HandleLocal, TransferRemoteTo,
    },
    processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, FeeConfig, HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction},
};
use hyperlane_test_utils::{
    assert_token_balance, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, transfer_lamports, IgpAccounts,
    MailboxAccounts,
};
use hyperlane_warp_route::TokenMessage;
use k256::ecdsa::{SigningKey, VerifyingKey};
use quote_verifier::SvmSignedQuote;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::instruction::initialize_mint2;
use std::collections::HashMap;

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

fn fee_program_id() -> Pubkey {
    pubkey!("Fee1111111111111111111111111111111111111111")
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

    program_test.add_program(
        "hyperlane_sealevel_fee",
        fee_program_id(),
        processor!(fee_process_instruction),
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

    let init = Init {
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

async fn set_cc_routers(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    updates: Vec<CrossCollateralRouterUpdate>,
) -> Result<(), BanksClientError> {
    let ixn =
        set_cross_collateral_routers_instruction(*program_id, payer.pubkey(), updates).unwrap();
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
        let ctx = TestContext::new(true).await;
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

        assert_eq!(
            token,
            Box::new(HyperlaneToken {
                bump: ctx.cc.token_bump,
                mailbox: ctx.mailbox_program_id,
                mailbox_process_authority: ctx.cc.mailbox_process_authority,
                dispatch_authority_bump: ctx.cc.dispatch_authority_bump,
                decimals: LOCAL_DECIMALS,
                remote_decimals: REMOTE_DECIMALS,
                owner: Some(ctx.payer.pubkey()),
                interchain_security_module: None,
                interchain_gas_paymaster: Some((
                    igp_program,
                    InterchainGasPaymasterType::OverheadIgp(igp_overhead_igp),
                )),
                destination_gas: HashMap::from([(REMOTE_DOMAIN, REMOTE_GAS_AMOUNT)]),
                remote_routers: HashMap::new(),
                plugin_data: CollateralPlugin {
                    spl_token_program: ctx.spl_token_program_id,
                    mint: ctx.mint,
                    escrow: ctx.cc.escrow,
                    escrow_bump: ctx.cc.escrow_bump,
                    ata_payer_bump: ctx.cc.ata_payer_bump,
                },
                fee_config: None,
            }),
        );

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
    async fn test_init_extraneous_accounts() {
        let env = setup_env().await;

        let init = Init {
            mailbox: env.mailbox_program_id,
            interchain_security_module: None,
            interchain_gas_paymaster: None,
            decimals: LOCAL_DECIMALS,
            remote_decimals: REMOTE_DECIMALS,
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

        // Custom(1) = TokenError::ExtraneousAccount
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
    async fn test_base_transfer_remote_uses_primary_router() {
        let mut ctx = TestContext::new(true).await;
        let igp = ctx.igp_accounts.as_ref().unwrap();
        let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
            (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

        // Enroll a primary (base) router for REMOTE_DOMAIN
        let primary_router = H256::random();
        enroll_remote_router(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            &ctx.cc.token,
            REMOTE_DOMAIN,
            primary_router,
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 42 * 10u64.pow(LOCAL_DECIMALS_U32);

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

        // Use base TransferRemote (no target_router field) — should resolve to primary_router
        use hyperlane_sealevel_token_lib::instruction::TransferRemote;
        let ixn_data = HyperlaneTokenInstruction::TransferRemote(TransferRemote {
            destination_domain: REMOTE_DOMAIN,
            recipient: remote_token_recipient,
            amount_or_id: transfer_amount.into(),
        })
        .encode()
        .unwrap();

        // Standard collateral transfer_remote account layout
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

        // Verify escrow received the tokens
        assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;
        assert_token_balance(
            &mut ctx.banks_client,
            &token_sender_ata,
            58 * 10u64.pow(LOCAL_DECIMALS_U32),
        )
        .await;

        // Verify the dispatched message was sent to the primary_router
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

        let expected_message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: LOCAL_DOMAIN,
            sender: ctx.program_id.to_bytes().into(),
            destination: REMOTE_DOMAIN,
            recipient: primary_router,
            body: TokenMessage::new(remote_token_recipient, remote_transfer_amount, vec![])
                .to_vec(),
        };
        assert_eq!(
            dispatched_message.encoded_message,
            expected_message.to_vec()
        );
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

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
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

            let result = set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &non_owner,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: H256::random(),
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

            let ixn_data = CrossCollateralInstruction::SetCrossCollateralRouters(vec![
                CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: H256::random(),
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

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router,
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
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router,
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

        #[tokio::test]
        async fn test_enroll_multiple_routers_same_domain_across_txs() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();
            let router_c = H256::random();

            // First tx: enroll router_a
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: router_a,
                }],
            )
            .await
            .unwrap();

            // Second tx: enroll router_b and router_c on the same domain
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_c,
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

            let routers = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert_eq!(routers.len(), 3);
            assert!(routers.contains(&router_a));
            assert!(routers.contains(&router_b));
            assert!(routers.contains(&router_c));
        }

        #[tokio::test]
        async fn test_enroll_routers_across_multiple_domains() {
            let mut ctx = TestContext::new(false).await;

            let other_domain: u32 = 42;
            let router_a = H256::random();
            let router_b = H256::random();
            let router_c = H256::random();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: other_domain,
                        router: router_c,
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

            let remote_routers = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert_eq!(remote_routers.len(), 2);
            assert!(remote_routers.contains(&router_a));
            assert!(remote_routers.contains(&router_b));

            let other_routers = cc_state.enrolled_routers.get(&other_domain).unwrap();
            assert_eq!(other_routers.len(), 1);
            assert!(other_routers.contains(&router_c));
        }
    }

    mod cc_unenroll {
        use super::*;

        #[tokio::test]
        async fn test_none_removes_all_routers_for_domain() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: router_a,
                }],
            )
            .await
            .unwrap();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
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
        async fn test_none_removes_multiple_routers_for_domain() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
                    },
                ],
            )
            .await
            .unwrap();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
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
        async fn test_none_then_reenroll_subset() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();

            // Enroll both routers
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
                    },
                ],
            )
            .await
            .unwrap();

            // Remove all, then re-enroll only router_b
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
            )
            .await
            .unwrap();

            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: router_b,
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
            assert_eq!(routers.len(), 1);
            assert!(!routers.contains(&router_a));
            assert!(routers.contains(&router_b));
        }

        #[tokio::test]
        async fn test_none_noop_on_unknown_domain() {
            let mut ctx = TestContext::new(false).await;

            // Unenroll a domain that was never enrolled — should succeed as a no-op
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: 99999,
                    router: None,
                })],
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

            assert!(!cc_state.enrolled_routers.contains_key(&99999));
        }

        #[tokio::test]
        async fn test_mixed_enroll_and_unenroll_across_domains() {
            let mut ctx = TestContext::new(false).await;

            let other_domain: u32 = 42;
            let router_a = H256::random();
            let router_b = H256::random();

            // Enroll routers on two domains
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: other_domain,
                        router: router_b,
                    },
                ],
            )
            .await
            .unwrap();

            // In one call: unenroll REMOTE_DOMAIN, enroll a new router on other_domain
            let router_c = H256::random();
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                        domain: REMOTE_DOMAIN,
                        router: None,
                    }),
                    CrossCollateralRouterUpdate::Add {
                        domain: other_domain,
                        router: router_c,
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

            // REMOTE_DOMAIN fully removed
            assert!(!cc_state.enrolled_routers.contains_key(&REMOTE_DOMAIN));
            // other_domain has both router_b and router_c
            let routers = cc_state.enrolled_routers.get(&other_domain).unwrap();
            assert_eq!(routers.len(), 2);
            assert!(routers.contains(&router_b));
            assert!(routers.contains(&router_c));
        }

        #[tokio::test]
        async fn test_unenroll_wrong_signer() {
            let mut ctx = TestContext::new(false).await;

            let router = H256::random();
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router,
                }],
            )
            .await
            .unwrap();

            let non_owner =
                new_funded_keypair(&mut ctx.banks_client, &ctx.payer, ONE_SOL_IN_LAMPORTS).await;

            let result = set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &non_owner,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
            )
            .await;

            assert_transaction_error(
                result,
                TransactionError::InstructionError(0, InstructionError::InvalidArgument),
            );
        }

        #[tokio::test]
        async fn test_ownership_transfer_then_router_management() {
            let mut ctx = TestContext::new(false).await;
            let old_owner = &ctx.payer;
            let old_owner_pubkey = old_owner.pubkey();

            // Enroll a router as current owner
            let router = H256::random();
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                old_owner,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router,
                }],
            )
            .await
            .unwrap();

            // Transfer ownership to new_owner
            let new_owner =
                new_funded_keypair(&mut ctx.banks_client, old_owner, ONE_SOL_IN_LAMPORTS).await;
            let new_owner_pubkey = new_owner.pubkey();

            let (token_key, _) =
                Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &ctx.program_id);
            let transfer_ownership_ixn_data =
                HyperlaneTokenInstruction::TransferOwnership(Some(new_owner_pubkey))
                    .encode()
                    .unwrap();
            let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
            let transaction = Transaction::new_signed_with_payer(
                &[Instruction::new_with_bytes(
                    ctx.program_id,
                    &transfer_ownership_ixn_data,
                    vec![
                        AccountMeta::new(token_key, false),
                        AccountMeta::new_readonly(old_owner_pubkey, true),
                    ],
                )],
                Some(&old_owner_pubkey),
                &[old_owner],
                recent_blockhash,
            );
            ctx.banks_client
                .process_transaction(transaction)
                .await
                .unwrap();

            // Old owner tries to enroll — should fail
            let result = set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                old_owner,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: H256::random(),
                }],
            )
            .await;

            assert_transaction_error(
                result,
                TransactionError::InstructionError(0, InstructionError::InvalidArgument),
            );

            // Old owner tries to unenroll — should fail
            let result = set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                old_owner,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
            )
            .await;

            assert_transaction_error(
                result,
                TransactionError::InstructionError(0, InstructionError::InvalidArgument),
            );

            // New owner can enroll — should succeed
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &new_owner,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: H256::random(),
                }],
            )
            .await
            .unwrap();

            // New owner can unenroll — should succeed
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &new_owner,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: None,
                })],
            )
            .await
            .unwrap();
        }

        #[tokio::test]
        async fn test_remove_specific_router_from_domain() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_b = H256::random();
            let router_c = H256::random();

            // Enroll three routers on one domain
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_a,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_b,
                    },
                    CrossCollateralRouterUpdate::Add {
                        domain: REMOTE_DOMAIN,
                        router: router_c,
                    },
                ],
            )
            .await
            .unwrap();

            // Remove only router_b
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_b),
                })],
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
            assert_eq!(routers.len(), 2);
            assert!(routers.contains(&router_a));
            assert!(!routers.contains(&router_b));
            assert!(routers.contains(&router_c));
        }

        #[tokio::test]
        async fn test_remove_specific_router_noop_on_nonexistent() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();
            let router_nonexistent = H256::random();

            // Enroll one router
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: router_a,
                }],
            )
            .await
            .unwrap();

            // Remove a router that was never enrolled — should succeed as no-op
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_nonexistent),
                })],
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

            // Original router still enrolled, unchanged
            let routers = cc_state.enrolled_routers.get(&REMOTE_DOMAIN).unwrap();
            assert_eq!(routers.len(), 1);
            assert!(routers.contains(&router_a));
        }

        #[tokio::test]
        async fn test_remove_last_specific_router_cleans_domain() {
            let mut ctx = TestContext::new(false).await;

            let router_a = H256::random();

            // Enroll a single router
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Add {
                    domain: REMOTE_DOMAIN,
                    router: router_a,
                }],
            )
            .await
            .unwrap();

            // Remove it specifically (not via None/remove-all)
            set_cc_routers(
                &mut ctx.banks_client,
                &ctx.program_id,
                &ctx.payer,
                vec![CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                    domain: REMOTE_DOMAIN,
                    router: Some(router_a),
                })],
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

            // Domain entry fully cleaned up (no empty set left behind)
            assert!(!cc_state.enrolled_routers.contains_key(&REMOTE_DOMAIN));
        }
    }
}

mod handle_instruction {
    use super::*;

    #[tokio::test]
    async fn test_handle_from_mailbox_cc_router() {
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

        let cc_router = H256::random();
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: REMOTE_DOMAIN,
                router: cc_router,
            }],
        )
        .await
        .unwrap();

        assert_token_balance(
            &mut ctx.banks_client,
            &ctx.cc.escrow,
            initial_escrow_balance,
        )
        .await;

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

        // Custom(1000) = CcError::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1000)),
        );
    }
}

mod handle_local_instruction {
    use super::*;

    #[tokio::test]
    async fn test_handle_local_rejects_without_valid_signer() {
        let mut ctx = TestContext::new(false).await;

        let local_cc_router = H256::from([7u8; 32]);
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: local_cc_router,
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

        // Custom(1001) = CcError::InvalidDispatchAuthority
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1001)),
        );
    }

    #[tokio::test]
    async fn test_handle_local_pda_signer_required() {
        // Correct PDA key but NOT a signer → MissingRequiredSignature
        let ctx = TestContext::new(false).await;

        let handle_local = HandleLocal {
            sender_program_id: ctx.program_id,
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
        // A calls B.HandleLocal via TransferRemoteTo (local), but A is NOT enrolled in B's CC state.
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let cc_b = ctx.init_second_cc_token().await;

        // Enroll B in A's CC state (so A can call TransferRemoteTo (local) targeting B)
        let router_b = H256::from(program_b.to_bytes());
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
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

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

        // Custom(1000) = CcError::UnauthorizedRouter — B rejects A
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1000)),
        );
    }

    #[tokio::test]
    async fn test_handle_local_accepts_base_remote_router() {
        // Base remote router enrollment also authorizes HandleLocal via
        // is_authorized_router (checks both CC enrolled and base routers).
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let cc_b = ctx.init_second_cc_token().await;

        let router_b = H256::from(program_b.to_bytes());
        let router_a = H256::from(ctx.program_id.to_bytes());

        // Enroll B in A's CC state (so A can call TransferRemoteTo (local) targeting B)
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
            }],
        )
        .await
        .unwrap();

        // Enroll A as B's BASE remote router (not CC router)
        enroll_remote_router(
            &mut ctx.banks_client,
            &program_b,
            &ctx.payer,
            &cc_b.token,
            LOCAL_DOMAIN,
            router_a,
        )
        .await
        .unwrap();

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

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

        // Should succeed — is_authorized_router accepts base remote routers too
        result.unwrap();
    }

    #[tokio::test]
    async fn test_transfer_local_same_chain() {
        // A.TransferRemoteTo (local) escrows in A, CPIs into B.HandleLocal which releases from B.
        let mut ctx = TestContext::new(false).await;
        let program_a = ctx.program_id;
        let program_b = second_cc_program_id();
        let cc_b = ctx.init_second_cc_token().await;

        // Mutual enrollment
        let router_b = H256::from(program_b.to_bytes());
        let router_a = H256::from(program_a.to_bytes());
        set_cc_routers(
            &mut ctx.banks_client,
            &program_a,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
            }],
        )
        .await
        .unwrap();
        set_cc_routers(
            &mut ctx.banks_client,
            &program_b,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_a,
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

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

        // Custom(1000) = CcError::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1000)),
        );
    }

    #[tokio::test]
    async fn test_transfer_local_rejects_wrong_dispatch_authority() {
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let router_b = H256::from(program_b.to_bytes());

        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

        // Custom(1001) = CcError::InvalidDispatchAuthority
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1001)),
        );
    }

    #[tokio::test]
    async fn test_transfer_local_rejects_target_program_mismatch() {
        let mut ctx = TestContext::new(false).await;
        let program_b = second_cc_program_id();
        let router_b = H256::from(program_b.to_bytes());

        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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

    #[tokio::test]
    async fn test_transfer_local_rejects_non_executable_target() {
        let mut ctx = TestContext::new(false).await;
        // Use an arbitrary pubkey that is NOT registered as a program in the test bank
        let non_executable = Pubkey::new_unique();
        let router_b = H256::from(non_executable.to_bytes());

        // Enroll it as a CC router for the local domain
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: router_b,
            }],
        )
        .await
        .unwrap();

        let (token_sender, token_sender_ata) = ctx
            .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

        let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: LOCAL_DOMAIN,
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
                    AccountMeta::new_readonly(non_executable, false),
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

        // InvalidAccountData — target program is not executable
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidAccountData),
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
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: REMOTE_DOMAIN,
                router: target_router,
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
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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

        // Custom(1000) = CcError::UnauthorizedRouter
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1000)),
        );
    }

    #[tokio::test]
    async fn test_transfer_remote_to_local_rejects_wrong_accounts() {
        // Passing remote-path accounts (SPL Noop at index 3) for a local-domain transfer
        // should fail because the local path expects a signer at index 3.
        let mut ctx = TestContext::new(false).await;

        let local_cc_router = H256::random();
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: LOCAL_DOMAIN,
                router: local_cc_router,
            }],
        )
        .await
        .unwrap();

        let (token_sender, _token_sender_ata) = ctx
            .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
            .await;
        let token_sender_pubkey = token_sender.pubkey();
        let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

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
                // Intentionally passing remote-path accounts for a local-domain transfer
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    // SPL Noop is not a signer — local path rejects this
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        );
        let result = ctx.banks_client.process_transaction(transaction).await;

        // MissingRequiredSignature — account 3 is not a signer
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
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
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: REMOTE_DOMAIN,
                router: target_router,
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
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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

        // Custom(1) = TokenError::ExtraneousAccount
        assert_transaction_error(
            result,
            TransactionError::InstructionError(0, InstructionError::Custom(1)),
        );
    }

    #[tokio::test]
    async fn test_transfer_remote_to_cross_chain_no_igp() {
        let mut ctx = TestContext::new(false).await;

        let target_router = H256::random();
        set_cc_routers(
            &mut ctx.banks_client,
            &ctx.program_id,
            &ctx.payer,
            vec![CrossCollateralRouterUpdate::Add {
                domain: REMOTE_DOMAIN,
                router: target_router,
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
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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

mod account_metas_simulation {
    use super::*;

    /// Helper: simulate an instruction and return the deserialized account metas.
    async fn simulate_and_get_account_metas(
        banks_client: &mut BanksClient,
        payer: &Keypair,
        program_id: Pubkey,
        ixn_data: Vec<u8>,
        accounts: Vec<AccountMeta>,
    ) -> Vec<AccountMeta> {
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        let return_data = banks_client
            .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
                &[Instruction::new_with_bytes(program_id, &ixn_data, accounts)],
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

        let serializable: Vec<SerializableAccountMeta> =
            SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(
                return_data.as_slice(),
            )
            .unwrap()
            .return_data;
        serializable.into_iter().map(Into::into).collect()
    }

    #[tokio::test]
    async fn test_handle_local_account_metas() {
        let ctx = TestContext::new(false).await;
        let sender_program_id = Pubkey::new_unique();

        let recipient_pubkey = Pubkey::new_unique();
        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let amount: U256 = U256::from(42u64) * U256::from(10u64).pow(U256::from(REMOTE_DECIMALS));
        let token_message = TokenMessage::new(recipient, amount, vec![]);

        let handle_local = HandleLocal {
            sender_program_id,

            message: token_message.to_vec(),
        };

        let ixn_data = CrossCollateralInstruction::HandleLocalAccountMetas(handle_local)
            .encode()
            .unwrap();

        let account_metas = simulate_and_get_account_metas(
            &mut ctx.banks_client.clone(),
            &ctx.payer,
            ctx.program_id,
            ixn_data,
            vec![AccountMeta::new_readonly(ctx.cc.token, false)],
        )
        .await;

        // Verify expected accounts are present
        assert!(!account_metas.is_empty());

        // Account 0: CC dispatch authority from sender (signer)
        let (expected_dispatch_authority, _) = Pubkey::find_program_address(
            cross_collateral_dispatch_authority_pda_seeds!(),
            &sender_program_id,
        );
        assert_eq!(account_metas[0].pubkey, expected_dispatch_authority);
        assert!(account_metas[0].is_signer);

        // Account 1: system_program
        assert_eq!(account_metas[1].pubkey, system_program::ID);

        // Account 2: token PDA
        assert_eq!(account_metas[2].pubkey, ctx.cc.token);

        // Account 3: CC state PDA
        assert_eq!(account_metas[3].pubkey, ctx.cc.cc_state);

        // Account 4: recipient
        assert_eq!(account_metas[4].pubkey, recipient_pubkey);
    }

    #[tokio::test]
    async fn test_transfer_from_remote_account_metas_cc() {
        let ctx = TestContext::new(false).await;

        let recipient_pubkey = Pubkey::new_unique();
        let recipient: H256 = recipient_pubkey.to_bytes().into();
        let amount: U256 = U256::from(42u64) * U256::from(10u64).pow(U256::from(REMOTE_DECIMALS));
        let token_message = TokenMessage::new(recipient, amount, vec![]);

        let handle = HandleInstruction {
            origin: REMOTE_DOMAIN,
            sender: H256::random(),
            message: token_message.to_vec(),
        };

        let ixn_data = MessageRecipientInstruction::HandleAccountMetas(handle)
            .encode()
            .unwrap();

        let account_metas = simulate_and_get_account_metas(
            &mut ctx.banks_client.clone(),
            &ctx.payer,
            ctx.program_id,
            ixn_data,
            vec![AccountMeta::new_readonly(ctx.cc.token, false)],
        )
        .await;

        // Verify expected accounts are present
        assert!(!account_metas.is_empty());

        // Account 0: system_program
        assert_eq!(account_metas[0].pubkey, system_program::ID);

        // Account 1: token PDA
        assert_eq!(account_metas[1].pubkey, ctx.cc.token);

        // Account 2: CC state PDA (inserted before recipient)
        assert_eq!(account_metas[2].pubkey, ctx.cc.cc_state);

        // Account 3: recipient
        assert_eq!(account_metas[3].pubkey, recipient_pubkey);
    }
}

// === Fee integration tests ===

const FEE_MAX: u64 = 100;
const FEE_HALF_AMOUNT: u64 = 500_000;

#[tokio::test]
async fn test_cc_remote_transfer_with_fee() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Initialize Leaf fee account.
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: None,
    });
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            ctx.payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config on the token.
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = FEE_MAX;

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    // Standing quote PDAs.
    let domain_standing_quote_pda = {
        let domain_le = REMOTE_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fee_program_id(),
        );
        pda
    };
    let wildcard_standing_quote_pda = {
        let domain_le = WILDCARD_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fee_program_id(),
        );
        pda
    };

    let remote_token_recipient = H256::random();

    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: remote_token_recipient,
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    // Account layout: CC prefix -> Core -> Fee -> IGP -> Plugin
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    // CC prefix
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    // Core (shared remote-dispatch)
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // Fee section
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false), // terminal
                    // IGP
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    // Plugin (collateral)
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify sender balance: initial - transfer - fee.
    assert_token_balance(
        &mut ctx.banks_client,
        &token_sender_ata,
        (100 * 10u64.pow(LOCAL_DECIMALS_U32)) - transfer_amount - expected_fee,
    )
    .await;

    // Verify beneficiary received exact fee.
    assert_token_balance(&mut ctx.banks_client, &fee_beneficiary_ata, expected_fee).await;

    // Verify escrow received transfer amount.
    assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;

    // Verify dispatch succeeded.
    assert!(
        ctx.banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

#[tokio::test]
async fn test_cc_local_transfer_with_fee() {
    // A.TransferRemoteTo (local) with fee: escrows in A (with fee), CPIs into B.HandleLocal.
    let mut ctx = TestContext::new(false).await;
    let program_a = ctx.program_id;
    let program_b = second_cc_program_id();
    let cc_b = ctx.init_second_cc_token().await;

    // Mutual enrollment
    let router_b = H256::from(program_b.to_bytes());
    let router_a = H256::from(program_a.to_bytes());
    set_cc_routers(
        &mut ctx.banks_client,
        &program_a,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: LOCAL_DOMAIN,
            router: router_b,
        }],
    )
    .await
    .unwrap();
    set_cc_routers(
        &mut ctx.banks_client,
        &program_b,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: LOCAL_DOMAIN,
            router: router_a,
        }],
    )
    .await
    .unwrap();

    // Fund B's escrow and ATA payer
    let escrow_b_amount = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    ctx.fund_escrow_and_ata_payer(cc_b.escrow, cc_b.ata_payer, escrow_b_amount)
        .await;

    // Initialize Leaf fee account on program A.
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: None,
    });
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            ctx.payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config on program A's token.
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_a,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Standing quote PDAs.
    let domain_standing_quote_pda = {
        let domain_le = LOCAL_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fee_program_id(),
        );
        pda
    };
    let wildcard_standing_quote_pda = {
        let domain_le = WILDCARD_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fee_program_id(),
        );
        pda
    };

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(50 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount = 25 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = FEE_MAX;

    let recipient_pubkey = Pubkey::new_unique();
    let recipient: H256 = recipient_pubkey.to_bytes().into();
    let recipient_ata = spl_associated_token_account::get_associated_token_address_with_program_id(
        &recipient_pubkey,
        &ctx.mint,
        &ctx.spl_token_program_id,
    );

    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: LOCAL_DOMAIN,
        recipient,
        amount_or_id: transfer_amount.into(),
        target_router: router_b,
    })
    .encode()
    .unwrap();

    // Account layout: CC prefix -> sender -> cc_dispatch_auth -> target_program
    //   -> Fee section -> Plugin A -> B's HandleLocal accounts
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_a,
                &ixn_data,
                vec![
                    // CC prefix
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    // Local path accounts
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(ctx.cc.cc_dispatch_authority, false),
                    AccountMeta::new_readonly(program_b, false),
                    // Fee section
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false), // terminal
                    // Plugin A (collateral transfer_in)
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                    // B's HandleLocal accounts (passthrough)
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
        ))
        .await
        .unwrap();

    // Verify sender: initial(50) - transfer(25) - fee
    assert_token_balance(
        &mut ctx.banks_client,
        &token_sender_ata,
        50 * 10u64.pow(LOCAL_DECIMALS_U32) - transfer_amount - expected_fee,
    )
    .await;

    // Verify beneficiary received exact fee.
    assert_token_balance(&mut ctx.banks_client, &fee_beneficiary_ata, expected_fee).await;

    // Verify A's escrow received transfer amount.
    assert_token_balance(&mut ctx.banks_client, &ctx.cc.escrow, transfer_amount).await;

    // Verify B released to recipient.
    assert_token_balance(
        &mut ctx.banks_client,
        &cc_b.escrow,
        escrow_b_amount - transfer_amount,
    )
    .await;
    assert_token_balance(&mut ctx.banks_client, &recipient_ata, transfer_amount).await;
}

#[tokio::test]
async fn test_cc_remote_transfer_with_fee_routing_mode() {
    use hyperlane_sealevel_fee::accounts::RoutingFeeConfig;

    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Init Routing-mode fee account + set route.
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fp = fee_program_id();
    let (fee_account_key, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);

    let route_max_fee: u64 = 50;
    let route_half_amount: u64 = 500_000;

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                fee_instruction::init_fee_instruction(
                    fp,
                    ctx.payer.pubkey(),
                    fee_salt,
                    fee_beneficiary_owner,
                    FeeData::Routing(RoutingFeeConfig {
                        wildcard_signers: std::collections::BTreeSet::new(),
                    }),
                    LOCAL_DOMAIN,
                )
                .unwrap(),
                fee_instruction::set_remote_fee_route_instruction(
                    fp,
                    fee_account_key,
                    ctx.payer.pubkey(),
                    REMOTE_DOMAIN,
                    None,
                    FeeDataStrategy::Linear(FeeParams {
                        max_fee: route_max_fee,
                        half_amount: route_half_amount,
                    }),
                    None,
                )
                .unwrap(),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Set fee config.
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fp,
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = route_max_fee;

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let domain_standing_quote_pda = {
        let d = REMOTE_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(fee_standing_quote_pda_seeds!(&fee_account_key, &d), &fp).0
    };
    let wildcard_standing_quote_pda = {
        let d = WILDCARD_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(fee_standing_quote_pda_seeds!(&fee_account_key, &d), &fp).0
    };
    let route_pda = {
        use hyperlane_sealevel_fee::route_domain_pda_seeds;
        let d = REMOTE_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(route_domain_pda_seeds!(fee_account_key, &d), &fp).0
    };

    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    // CC prefix
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    // Core
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    // Fee (Routing)
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new_readonly(route_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false),
                    // IGP
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    // Plugin
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await
        .unwrap();

    assert_token_balance(
        &mut ctx.banks_client,
        &token_sender_ata,
        (100 * 10u64.pow(LOCAL_DECIMALS_U32)) - transfer_amount - expected_fee,
    )
    .await;
    assert_token_balance(&mut ctx.banks_client, &fee_beneficiary_ata, expected_fee).await;
}

#[tokio::test]
async fn test_cc_remote_transfer_with_fee_cc_routing_mode() {
    use hyperlane_sealevel_fee::accounts::CrossCollateralRoutingFeeConfig;

    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Init CrossCollateralRouting-mode fee account.
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fp = fee_program_id();
    let (fee_account_key, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);

    let route_max_fee: u64 = 75;
    let route_half_amount: u64 = 500_000;

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                fee_instruction::init_fee_instruction(
                    fp,
                    ctx.payer.pubkey(),
                    fee_salt,
                    fee_beneficiary_owner,
                    FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                        wildcard_signers: std::collections::BTreeSet::new(),
                    }),
                    LOCAL_DOMAIN,
                )
                .unwrap(),
                // Set a CC route for (REMOTE_DOMAIN, target_router).
                fee_instruction::set_remote_fee_route_instruction(
                    fp,
                    fee_account_key,
                    ctx.payer.pubkey(),
                    REMOTE_DOMAIN,
                    Some(target_router),
                    FeeDataStrategy::Linear(FeeParams {
                        max_fee: route_max_fee,
                        half_amount: route_half_amount,
                    }),
                    None,
                )
                .unwrap(),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Set fee config on the token.
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fp,
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = route_max_fee; // amount >> half_amount → capped

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    // CC standing quote PDAs use target_router in seeds.
    let domain_standing_quote_pda = {
        let d = REMOTE_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d, &target_router),
            &fp,
        )
        .0
    };
    let wildcard_standing_quote_pda = {
        let d = WILDCARD_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d, &target_router),
            &fp,
        )
        .0
    };
    // CC specific route PDA for (REMOTE_DOMAIN, target_router).
    let cc_route_pda = {
        use hyperlane_sealevel_fee::cc_route_pda_seeds;
        let d = REMOTE_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(
            cc_route_pda_seeds!(fee_account_key, &d, &target_router),
            &fp,
        )
        .0
    };

    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    // CC prefix
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    // Core
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    // Fee (CrossCollateralRouting: CC standing quotes + CC route PDA)
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new_readonly(cc_route_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false),
                    // IGP
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    // Plugin
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await
        .unwrap();

    assert_token_balance(
        &mut ctx.banks_client,
        &token_sender_ata,
        (100 * 10u64.pow(LOCAL_DECIMALS_U32)) - transfer_amount - expected_fee,
    )
    .await;
    assert_token_balance(&mut ctx.banks_client, &fee_beneficiary_ata, expected_fee).await;
}

// === Additional fee tests for parity with native ===

#[tokio::test]
async fn test_set_fee_config() {
    let ctx = TestContext::new(false).await;

    let account_data = ctx
        .banks_client
        .get_account(ctx.cc.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);

    let fee_salt = H256::zero();
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            ctx.payer.pubkey(),
            fee_salt,
            Pubkey::new_unique(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: FEE_MAX,
                    half_amount: FEE_HALF_AMOUNT,
                }),
                signers: None,
            }),
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_account_key,
    };
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(fee_config.clone()))
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_config.fee_program, false),
                    AccountMeta::new_readonly(fee_config.fee_account, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let account_data = ctx
        .banks_client
        .get_account(ctx.cc.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, Some(fee_config));

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(None)
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let account_data = ctx
        .banks_client
        .get_account(ctx.cc.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);
}

#[tokio::test]
async fn test_set_fee_config_non_owner_fails() {
    let mut ctx = TestContext::new(false).await;
    let non_owner =
        new_funded_keypair(&mut ctx.banks_client, &ctx.payer, ONE_SOL_IN_LAMPORTS).await;
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: Pubkey::new_unique(),
                    fee_account: Pubkey::new_unique(),
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(non_owner.pubkey(), true),
                ],
            )],
            Some(&non_owner.pubkey()),
            &[&non_owner],
            recent_blockhash,
        ))
        .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_get_program_version() {
    use package_versioned::{get_program_version_instruction_data, PACKAGE_VERSION};
    let program_id = hyperlane_sealevel_token_cross_collateral_id();
    let (banks_client, payer) = setup_client().await;
    let ix =
        Instruction::new_with_bytes(program_id, &get_program_version_instruction_data(), vec![]);
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[ix],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let version: SimulationReturnData<String> =
        borsh::BorshDeserialize::try_from_slice(&return_data).unwrap();
    assert_eq!(version.return_data, PACKAGE_VERSION);
}

#[tokio::test]
async fn test_set_fee_config_wrong_fee_account_owner() {
    let ctx = TestContext::new(false).await;
    let wrong_fee_account = ctx.cc.token;
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: wrong_fee_account,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(wrong_fee_account, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

struct CcFeeTestContext {
    ctx: TestContext,
    igp_program: Pubkey,
    igp_program_data: Pubkey,
    igp_overhead_igp: Pubkey,
    igp_igp: Pubkey,
    target_router: H256,
    token_sender: Keypair,
    token_sender_ata: Pubkey,
    fee_account_key: Pubkey,
    fee_beneficiary_ata: Pubkey,
    domain_standing_quote_pda: Pubkey,
    wildcard_standing_quote_pda: Pubkey,
}

async fn setup_cc_fee_test_context() -> CcFeeTestContext {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            ctx.payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: FEE_MAX,
                    half_amount: FEE_HALF_AMOUNT,
                }),
                signers: None,
            }),
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;

    let domain_standing_quote_pda = {
        let d = REMOTE_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d),
            &fee_program_id(),
        );
        pda
    };
    let wildcard_standing_quote_pda = {
        let d = WILDCARD_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d),
            &fee_program_id(),
        );
        pda
    };

    CcFeeTestContext {
        ctx,
        igp_program,
        igp_program_data,
        igp_overhead_igp,
        igp_igp,
        target_router,
        token_sender,
        token_sender_ata,
        fee_account_key,
        fee_beneficiary_ata,
        domain_standing_quote_pda,
        wildcard_standing_quote_pda,
    }
}

#[tokio::test]
async fn test_transfer_remote_with_fee_wrong_fee_program() {
    let fctx = setup_cc_fee_test_context().await;
    let token_sender_pubkey = fctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let wrong_fee_program = Pubkey::new_unique();
    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &fctx.ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router: fctx.target_router,
    })
    .encode()
    .unwrap();
    let recent_blockhash = fctx.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = fctx
        .ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                fctx.ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.token, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(fctx.ctx.mailbox_program_id, false),
                    AccountMeta::new(fctx.ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    AccountMeta::new_readonly(wrong_fee_program, false),
                    AccountMeta::new_readonly(fctx.fee_account_key, false),
                    AccountMeta::new_readonly(fctx.domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(fctx.wildcard_standing_quote_pda, false),
                    AccountMeta::new(fctx.fee_beneficiary_ata, false),
                    AccountMeta::new_readonly(fctx.igp_program, false),
                    AccountMeta::new(fctx.igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(fctx.igp_overhead_igp, false),
                    AccountMeta::new(fctx.igp_igp, false),
                    AccountMeta::new_readonly(fctx.ctx.spl_token_program_id, false),
                    AccountMeta::new(fctx.ctx.mint, false),
                    AccountMeta::new(fctx.token_sender_ata, false),
                    AccountMeta::new(fctx.ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&fctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_transfer_remote_with_fee_missing_beneficiary() {
    let fctx = setup_cc_fee_test_context().await;
    let token_sender_pubkey = fctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &fctx.ctx.mailbox_program_id,
    );
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router: fctx.target_router,
    })
    .encode()
    .unwrap();
    let recent_blockhash = fctx.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = fctx
        .ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                fctx.ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.token, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(fctx.ctx.mailbox_program_id, false),
                    AccountMeta::new(fctx.ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(fctx.ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fctx.fee_account_key, false),
                    AccountMeta::new_readonly(fctx.domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(fctx.wildcard_standing_quote_pda, false),
                    // NO beneficiary
                ],
            )],
            Some(&token_sender_pubkey),
            &[&fctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            #[allow(deprecated)]
            InstructionError::NotEnoughAccountKeys,
        ),
    );
}

#[tokio::test]
async fn test_transfer_remote_with_fee_beneficiary_not_found_cap() {
    let fctx = setup_cc_fee_test_context().await;
    let token_sender_pubkey = fctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &fctx.ctx.mailbox_program_id,
    );
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router: fctx.target_router,
    })
    .encode()
    .unwrap();
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(fctx.ctx.cc.token, false),
        AccountMeta::new_readonly(fctx.ctx.cc.cc_state, false),
        AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new_readonly(fctx.ctx.mailbox_program_id, false),
        AccountMeta::new(fctx.ctx.mailbox_accounts.outbox, false),
        AccountMeta::new_readonly(fctx.ctx.cc.dispatch_authority, false),
        AccountMeta::new(token_sender_pubkey, true),
        AccountMeta::new_readonly(unique_msg.pubkey(), true),
        AccountMeta::new(dispatched_msg_key, false),
        AccountMeta::new_readonly(fee_program_id(), false),
        AccountMeta::new_readonly(fctx.fee_account_key, false),
    ];
    for _ in 0..16 {
        accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
    }
    let recent_blockhash = fctx.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = fctx
        .ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                fctx.ctx.program_id,
                &ixn_data,
                accounts,
            )],
            Some(&token_sender_pubkey),
            &[&fctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(6)),
    );
}

// ========================================================================
// IGP new flow helpers
// ========================================================================

const IGP_DOMAIN_ID: u32 = 42;

fn encode_u48(ts: i64) -> [u8; 6] {
    let mut out = [0u8; 6];
    out.copy_from_slice(&ts.to_be_bytes()[2..8]);
    out
}

fn encode_igp_context(fee_token_mint: &Pubkey, dest_domain: u32, sender: &Pubkey) -> Vec<u8> {
    let mut buf = Vec::with_capacity(68);
    buf.extend_from_slice(fee_token_mint.as_ref());
    buf.extend_from_slice(&dest_domain.to_le_bytes());
    buf.extend_from_slice(sender.as_ref());
    buf
}

fn encode_igp_data(exchange_rate: u128, gas_price: u128, token_decimals: u8) -> Vec<u8> {
    let mut buf = Vec::with_capacity(33);
    buf.extend_from_slice(&exchange_rate.to_le_bytes());
    buf.extend_from_slice(&gas_price.to_le_bytes());
    buf.push(token_decimals);
    buf
}

fn sign_hash(signing_key: &SigningKey, hash: &[u8; 32]) -> [u8; 65] {
    let (sig, recovery_id) = signing_key
        .sign_prehash_recoverable(hash)
        .expect("signing failed");
    let mut bytes = [0u8; 65];
    bytes[..64].copy_from_slice(&sig.to_bytes());
    bytes[64] = recovery_id.to_byte();
    bytes
}

fn eth_address(signing_key: &SigningKey) -> H160 {
    let verifying_key = VerifyingKey::from(signing_key);
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let hash = solana_program::keccak::hash(&pubkey_bytes.as_bytes()[1..]);
    H160::from_slice(&hash.as_ref()[12..])
}

fn derive_igp_standing_quote_pda(
    igp_key: &Pubkey,
    fee_token_mint: &Pubkey,
    dest_domain: u32,
    sender: &Pubkey,
) -> Pubkey {
    let dest_le = dest_domain.to_le_bytes();
    Pubkey::find_program_address(
        igp_standing_quote_pda_seeds!(igp_key, fee_token_mint, &dest_le, sender),
        &igp_program_id(),
    )
    .0
}

async fn setup_igp_new_flow(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_key: &Pubkey,
) -> SigningKey {
    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: IGP_DOMAIN_ID,
        min_issued_at: 0,
    };
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), *igp_key, payer.pubkey(), Some(config))
            .unwrap();
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            bh,
        ))
        .await
        .unwrap();

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_addr = eth_address(&signing_key);
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        *igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(signer_addr),
    )
    .unwrap();
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            bh,
        ))
        .await
        .unwrap();

    signing_key
}

#[allow(clippy::too_many_arguments)]
async fn submit_standing_igp_quote(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_key: &Pubkey,
    signing_key: &SigningKey,
    dest_domain: u32,
    sender: &Pubkey,
    exchange_rate: u128,
    gas_price: u128,
    token_decimals: u8,
) {
    let fee_token_mint = Pubkey::default();
    let context = encode_igp_context(&fee_token_mint, dest_domain, sender);
    let data = encode_igp_data(exchange_rate, gas_price, token_decimals);

    let clock: solana_program::clock::Clock = banks_client.get_sysvar().await.unwrap();
    let now = clock.unix_timestamp;

    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at: encode_u48(now),
        expiry: encode_u48(now + 3600),
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let message_hash = quote.build_message_hash(igp_key, IGP_DOMAIN_ID, &scoped_salt);
    quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());

    let quote_pda = derive_igp_standing_quote_pda(igp_key, &fee_token_mint, dest_domain, sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), *igp_key, quote_pda, quote)
            .unwrap();
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            bh,
        ))
        .await
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
async fn assert_igp_gas_payment(
    banks_client: &mut BanksClient,
    gas_payment_pda_key: Pubkey,
    dispatched_message_key: Pubkey,
    expected_igp: Pubkey,
    expected_destination_domain: u32,
    expected_unique_gas_payment_pubkey: Pubkey,
    expected_gas_amount: u64,
    expected_payment: u64,
) {
    let gas_payment = GasPaymentAccount::fetch(
        &mut &banks_client
            .get_account(gas_payment_pda_key)
            .await
            .unwrap()
            .unwrap()
            .data[..],
    )
    .unwrap()
    .into_inner();

    let dispatched_message = DispatchedMessageAccount::fetch(
        &mut &banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .unwrap()
            .data[..],
    )
    .unwrap()
    .into_inner();
    let message =
        HyperlaneMessage::read_from(&mut &dispatched_message.encoded_message[..]).unwrap();

    assert_eq!(gas_payment.data.igp, expected_igp);
    assert_eq!(
        gas_payment.data.destination_domain,
        expected_destination_domain
    );
    assert_eq!(
        gas_payment.data.unique_gas_payment_pubkey,
        expected_unique_gas_payment_pubkey
    );
    assert_eq!(gas_payment.data.message_id, message.id());
    assert_eq!(gas_payment.data.gas_amount, expected_gas_amount);
    assert_eq!(gas_payment.data.payment, expected_payment);
}

// ========================================================================
// IGP new flow tests (cross-collateral)
// ========================================================================

/// CC remote transfer with IGP new flow standing quote.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_standing() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    // IGP quoting setup.
    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;

    let quote_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let quote_gas_price: u128 = 5;

    submit_standing_igp_quote(
        &mut ctx.banks_client,
        &ctx.payer,
        &igp_igp,
        &signing_key,
        REMOTE_DOMAIN,
        &ctx.program_id,
        quote_exchange_rate,
        quote_gas_price,
        9,
    )
    .await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );

    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    // CC core
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // IGP new flow
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false), // TERMINAL
                    AccountMeta::new(igp_igp, false),
                    // Plugin (collateral)
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    // Verify quote pricing.
    let expected_payment = ((REMOTE_GAS_AMOUNT as u128) * quote_gas_price * quote_exchange_rate
        / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_ne!(expected_payment, REMOTE_GAS_AMOUNT);

    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gas_payment_pda_key,
        dispatched_message_key,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        expected_payment,
    )
    .await;
}

/// CC remote transfer with IGP new flow transient quote.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_transient() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;

    let igp_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let igp_gas_price: u128 = 5;

    // Build transient IGP quote.
    let clock: solana_program::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let now = clock.unix_timestamp;
    let issued_at_bytes = encode_u48(now);

    let igp_context = encode_igp_context(&Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let igp_data = encode_igp_data(igp_exchange_rate, igp_gas_price, 9);

    let mut igp_quote = SvmSignedQuote {
        context: igp_context,
        data: igp_data,
        issued_at: issued_at_bytes,
        expiry: issued_at_bytes, // transient
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let igp_scoped_salt = igp_quote.compute_scoped_salt(&token_sender_pubkey);
    let igp_msg_hash = igp_quote.build_message_hash(&igp_igp, IGP_DOMAIN_ID, &igp_scoped_salt);
    igp_quote.signature = sign_hash(&signing_key, igp_msg_hash.as_fixed_bytes());

    let (igp_transient_pda, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(&igp_igp, igp_scoped_salt),
        &igp_program_id(),
    );

    let igp_submit_ix = submit_igp_quote_instruction(
        igp_program_id(),
        token_sender_pubkey,
        igp_igp,
        igp_transient_pda,
        igp_quote,
    )
    .unwrap();
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[igp_submit_ix],
            Some(&token_sender_pubkey),
            &[&token_sender],
            bh,
        ))
        .await
        .unwrap();

    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new(igp_transient_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    let expected_payment = ((REMOTE_GAS_AMOUNT as u128) * igp_gas_price * igp_exchange_rate
        / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gas_payment_pda_key,
        dispatched_message_key,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        expected_payment,
    )
    .await;

    // Verify transient autoclosed.
    let acct = ctx
        .banks_client
        .get_account(igp_transient_pda)
        .await
        .unwrap();
    assert!(acct.is_none() || acct.unwrap().data.is_empty());
}

/// CC remote transfer with cascade oracle fallback.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_cascade_oracle_fallback() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    // Enable quoting but don't submit any quotes.
    let _signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );

    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    // Oracle fallback: payment == gas_amount.
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gas_payment_pda_key,
        dispatched_message_key,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        REMOTE_GAS_AMOUNT,
    )
    .await;
}

/// CC: cascade wildcard-sender resolves.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_cascade_wildcard_sender() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;
    let qer = 3 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 7;

    submit_standing_igp_quote(
        &mut ctx.banks_client,
        &ctx.payer,
        &igp_igp,
        &signing_key,
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
        qer,
        qgp,
        9,
    )
    .await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );

    let unique_msg = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gp, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let ta = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: ta.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    let ep = ((REMOTE_GAS_AMOUNT as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gp,
        dm,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        ep,
    )
    .await;
}

/// CC: cascade wildcard-domain resolves.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_cascade_wildcard_domain() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;
    let qer = 4 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 3;

    submit_standing_igp_quote(
        &mut ctx.banks_client,
        &ctx.payer,
        &igp_igp,
        &signing_key,
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
        qer,
        qgp,
        9,
    )
    .await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );

    let unique_msg = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gp, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let ta = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: ta.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    let ep = ((REMOTE_GAS_AMOUNT as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gp,
        dm,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        ep,
    )
    .await;
}

/// CC: overhead IGP applies to quoted payment.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_with_overhead() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Set gas overhead.
    let gas_overhead: u64 = 100_000;
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_borsh(
                igp_program_id(),
                &hyperlane_sealevel_igp::instruction::Instruction::SetDestinationGasOverheads(
                    vec![hyperlane_sealevel_igp::instruction::GasOverheadConfig {
                        destination_domain: REMOTE_DOMAIN,
                        gas_overhead: Some(gas_overhead),
                    }],
                ),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(igp_overhead_igp, false),
                    AccountMeta::new_readonly(ctx.payer.pubkey(), true),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            bh,
        ))
        .await
        .unwrap();

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();

    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;
    let qer = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 5;

    submit_standing_igp_quote(
        &mut ctx.banks_client,
        &ctx.payer,
        &igp_igp,
        &signing_key,
        REMOTE_DOMAIN,
        &ctx.program_id,
        qer,
        qgp,
        9,
    )
    .await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );
    let unique_msg = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gp, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let ta = 10 * 10u64.pow(LOCAL_DECIMALS_U32);
    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: ta.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false),
                    AccountMeta::new(igp_igp, false),
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    let expected_gas = REMOTE_GAS_AMOUNT + gas_overhead;
    let ep = ((expected_gas as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gp,
        dm,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        expected_gas,
        ep,
    )
    .await;
}

/// CC: fee (Leaf) + IGP new flow standing quote combined.
#[tokio::test]
async fn test_cc_remote_transfer_igp_new_flow_with_fee() {
    let mut ctx = TestContext::new(true).await;
    let igp = ctx.igp_accounts.as_ref().unwrap();
    let (igp_program, igp_program_data, igp_overhead_igp, igp_igp) =
        (igp.program, igp.program_data, igp.overhead_igp, igp.igp);

    let target_router = H256::random();
    set_cc_routers(
        &mut ctx.banks_client,
        &ctx.program_id,
        &ctx.payer,
        vec![CrossCollateralRouterUpdate::Add {
            domain: REMOTE_DOMAIN,
            router: target_router,
        }],
    )
    .await
    .unwrap();

    // Initialize Leaf fee account (same pattern as test_cc_remote_transfer_with_fee).
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: None,
    });
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            ctx.payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                bh,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config on the token.
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.cc.token, false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                ],
            )],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            bh,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &fee_beneficiary_owner,
            &ctx.mint,
            &ctx.spl_token_program_id,
        );
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &ctx.payer.pubkey(),
                    &fee_beneficiary_owner,
                    &ctx.mint,
                    &ctx.spl_token_program_id,
                ),
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            bh,
        ))
        .await
        .unwrap();

    let domain_standing_quote_pda = {
        let d = REMOTE_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d),
            &fee_program_id(),
        )
        .0
    };
    let wildcard_standing_quote_pda = {
        let d = WILDCARD_DOMAIN.to_le_bytes();
        Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &d),
            &fee_program_id(),
        )
        .0
    };

    // IGP quoting setup.
    let signing_key = setup_igp_new_flow(&mut ctx.banks_client, &ctx.payer, &igp_igp).await;
    let qer = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 5;

    submit_standing_igp_quote(
        &mut ctx.banks_client,
        &ctx.payer,
        &igp_igp,
        &signing_key,
        REMOTE_DOMAIN,
        &ctx.program_id,
        qer,
        qgp,
        9,
    )
    .await;

    let exact_pda =
        derive_igp_standing_quote_pda(&igp_igp, &Pubkey::default(), REMOTE_DOMAIN, &ctx.program_id);
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &hyperlane_sealevel_igp::accounts::WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_igp,
        &Pubkey::default(),
        hyperlane_sealevel_igp::accounts::WILDCARD_DOMAIN,
        &ctx.program_id,
    );

    let (token_sender, token_sender_ata) = ctx
        .create_funded_sender(100 * 10u64.pow(LOCAL_DECIMALS_U32))
        .await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = FEE_MAX; // amount >> half_amount

    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &ctx.mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let ixn_data = CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
        destination_domain: REMOTE_DOMAIN,
        recipient: H256::random(),
        amount_or_id: transfer_amount.into(),
        target_router,
    })
    .encode()
    .unwrap();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &ixn_data,
                vec![
                    // CC prefix
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(ctx.cc.token, false),
                    AccountMeta::new_readonly(ctx.cc.cc_state, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    // Core
                    AccountMeta::new_readonly(ctx.mailbox_program_id, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // Fee section
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false), // terminal
                    // IGP new flow
                    AccountMeta::new_readonly(igp_program, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.cc.dispatch_authority, false),
                    AccountMeta::new_readonly(ctx.program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_overhead_igp, false), // TERMINAL
                    AccountMeta::new(igp_igp, false),
                    // Plugin (collateral)
                    AccountMeta::new_readonly(ctx.spl_token_program_id, false),
                    AccountMeta::new(ctx.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                    AccountMeta::new(ctx.cc.escrow, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    // Verify fee deducted.
    assert_token_balance(&mut ctx.banks_client, &fee_beneficiary_ata, expected_fee).await;

    // Verify sender balance: initial - transfer - fee.
    assert_token_balance(
        &mut ctx.banks_client,
        &token_sender_ata,
        100 * 10u64.pow(LOCAL_DECIMALS_U32) - transfer_amount - expected_fee,
    )
    .await;

    // Verify IGP used quote pricing.
    let expected_igp_payment =
        ((REMOTE_GAS_AMOUNT as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut ctx.banks_client,
        gas_payment_pda_key,
        dispatched_message_key,
        igp_igp,
        REMOTE_DOMAIN,
        unique_msg.pubkey(),
        REMOTE_GAS_AMOUNT,
        expected_igp_payment,
    )
    .await;
}
