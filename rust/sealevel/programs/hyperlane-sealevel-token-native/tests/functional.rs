//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H160, H256, U256};
use k256::ecdsa::SigningKey;
use k256::ecdsa::VerifyingKey;
use quote_verifier::SvmSignedQuote;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;
use std::collections::HashMap;

use hyperlane_core::Decode;
use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_fee::{
    accounts::{FeeData, LeafFeeConfig, WILDCARD_DOMAIN},
    fee_account_pda_seeds,
    fee_math::FeeDataStrategy,
    fee_math::FeeParams,
    fee_standing_quote_pda_seeds, instruction as fee_instruction,
    processor::process_instruction as fee_process_instruction,
    route_domain_pda_seeds,
};
use hyperlane_sealevel_igp::{
    accounts::{
        GasPaymentAccount, GasPaymentData, IgpFeeConfig, InterchainGasPaymasterType,
        TOKEN_EXCHANGE_RATE_SCALE, WILDCARD_DOMAIN as IGP_WILDCARD_DOMAIN, WILDCARD_SENDER,
    },
    igp_gas_payment_pda_seeds, igp_standing_quote_pda_seeds, igp_transient_quote_pda_seeds,
    instruction::{
        set_igp_quote_config_instruction, set_igp_quote_signer_instruction,
        submit_igp_quote_instruction, GasOverheadConfig, Instruction as IgpProgramInstruction,
        SetIgpQuoteSignerOperation,
    },
};
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessage, DispatchedMessageAccount},
    mailbox_dispatched_message_pda_seeds, mailbox_message_dispatch_authority_pda_seeds,
    mailbox_outbox_pda_seeds, mailbox_process_authority_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, FeeConfig, HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction, TransferRemote},
};
use hyperlane_sealevel_token_native::{
    hyperlane_token_native_collateral_pda_seeds, plugin::NativePlugin,
    processor::process_instruction,
};
use hyperlane_test_utils::{
    assert_lamports, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, transfer_lamports, IgpAccounts,
};
use hyperlane_warp_route::TokenMessage;
use solana_commitment_config::CommitmentLevel;
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use tarpc::context::Context;

/// There are 1e9 lamports in one SOL.
const ONE_SOL_IN_LAMPORTS: u64 = 1000000000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 9;
const LOCAL_DECIMALS_U32: u32 = LOCAL_DECIMALS as u32;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
const REMOTE_GAS_AMOUNT: u64 = 200000;
const IGP_DOMAIN_ID: u32 = 42;

fn hyperlane_sealevel_token_native_id() -> Pubkey {
    pubkey!("CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_native_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token_native",
        program_id,
        processor!(process_instruction),
    );

    // spl_noop just logs data and returns success - provide a simple processor
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

    // This serves as the default ISM on the Mailbox
    program_test.add_program(
        "hyperlane_sealevel_test_ism",
        hyperlane_sealevel_test_ism::id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );

    program_test.add_program(
        "hyperlane_sealevel_fee",
        fee_program_id(),
        processor!(fee_process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

fn fee_program_id() -> Pubkey {
    pubkey!("Fee1111111111111111111111111111111111111111")
}

fn mailbox_outbox() -> Pubkey {
    Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &mailbox_id()).0
}

struct HyperlaneTokenAccounts {
    token: Pubkey,
    token_bump: u8,
    mailbox_process_authority: Pubkey,
    dispatch_authority: Pubkey,
    dispatch_authority_bump: u8,
    native_collateral: Pubkey,
    native_collateral_bump: u8,
}

async fn initialize_hyperlane_token(
    program_id: &Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_accounts: Option<&IgpAccounts>,
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

    let (native_collateral_account_key, native_collateral_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_native_collateral_pda_seeds!(), program_id);

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
                // 3. `[signer]` The payer and mailbox payer.
                // 4. `[writable]` The native collateral PDA account.
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(token_account_key, false),
                AccountMeta::new(dispatch_authority_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(native_collateral_account_key, false),
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
        native_collateral: native_collateral_account_key,
        native_collateral_bump: native_collateral_account_bump_seed,
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

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

    // Get the token account.
    let token_account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
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
            plugin_data: NativePlugin {
                native_collateral_bump: hyperlane_token_accounts.native_collateral_bump,
            },
            fee_config: None,
        }),
    );

    // Verify the ATA payer account was created.
    let native_collateral_account = banks_client
        .get_account(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap()
        .unwrap();
    assert!(native_collateral_account.lamports > 0);
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
        .await
        .unwrap();

    let other_payer = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // To ensure a different signature is used, we'll use a different payer
    let init_result =
        initialize_hyperlane_token(&program_id, &mut banks_client, &other_payer, None).await;

    assert_transaction_error(
        init_result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

#[tokio::test]
async fn test_transfer_remote() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
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

    // Send 100 SOL for the token sender to start with.
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();

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
    let transfer_amount = 69 * ONE_SOL_IN_LAMPORTS;
    let remote_transfer_amount =
        convert_decimals(transfer_amount.into(), LOCAL_DECIMALS, REMOTE_DECIMALS).unwrap();

    let sender_balance_before = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let native_collateral_account_lamports_before = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

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
            // 0.   `[executable]` The system program.
            // 1.   `[executable]` The spl_noop program.
            // 2.   `[]` The token PDA account.
            // 3.   `[executable]` The mailbox program.
            // 4.   `[writeable]` The mailbox outbox account.
            // 5.   `[]` Message dispatch authority.
            // 6.   `[signer]` The token sender and mailbox payer.
            // 7.   `[signer]` Unique message / gas payment account.
            // 8.   `[writeable]` Message storage PDA.
            //      ---- If using an IGP ----
            // 9.   `[executable]` The IGP program.
            // 10.  `[writeable]` The IGP program data.
            // 11.  `[writeable]` Gas payment PDA.
            // 12.  `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
            // 13.  `[writeable]` The IGP account.
            //      ---- End if ----
            // 14.  `[executable]` The system program.
            // 15.  `[writeable]` The native token collateral PDA account.
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );

    let transaction_fee = banks_client
        .get_fee_for_message_with_commitment_and_context(
            Context::current(),
            transaction.message.clone(),
            CommitmentLevel::Processed,
        )
        .await
        .unwrap()
        .unwrap();

    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // The transaction fee doesn't seem to be entirely accurate -
    // this may be due to a mismatch between the SDK and the actual
    // transaction fee calculation.
    // For now, we'll just check that the sender's balance roughly correct.
    let sender_balance_after = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let expected_balance_after = sender_balance_before - transfer_amount - transaction_fee;
    // Allow 0.005 SOL of extra transaction fees
    assert!(
        sender_balance_after >= expected_balance_after - 5000000
            && sender_balance_after <= expected_balance_after
    );

    // And that the native collateral account's balance is 69 tokens.
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        native_collateral_account_lamports_before + transfer_amount,
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

async fn transfer_from_remote(
    initial_native_collateral_balance: u64,
    remote_transfer_amount: U256,
    sender_override: Option<H256>,
    origin_override: Option<u32>,
) -> Result<(BanksClient, HyperlaneTokenAccounts, Pubkey), BanksClientError> {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
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

    // The native collateral account will have some lamports because it's rent-exempt.
    let current_native_collateral_balance = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

    // Give an initial balance to the native collateral account which will be used by the
    // transfer_from_remote.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.native_collateral,
        initial_native_collateral_balance.saturating_sub(current_native_collateral_balance),
    )
    .await;

    let recipient_pubkey = Pubkey::new_unique();
    let recipient: H256 = recipient_pubkey.to_bytes().into();

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

    Ok((banks_client, hyperlane_token_accounts, recipient_pubkey))
}

// Tests when the SPL token is the non-2022 version
#[tokio::test]
async fn test_transfer_from_success() {
    let initial_native_collateral_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let (mut banks_client, hyperlane_token_accounts, recipient_associated_token_account) =
        transfer_from_remote(
            initial_native_collateral_balance,
            remote_transfer_amount,
            None,
            None,
        )
        .await
        .unwrap();

    // Check that the recipient's ATA got the tokens!
    assert_lamports(
        &mut banks_client,
        &recipient_associated_token_account,
        local_transfer_amount,
    )
    .await;

    // And that the native collateral's balance is lower because it was spent in the transfer.
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        initial_native_collateral_balance - local_transfer_amount,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_sender_not_router() {
    let initial_native_collateral_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    // Same remote domain origin, but wrong sender.
    let result = transfer_from_remote(
        initial_native_collateral_balance,
        remote_transfer_amount,
        Some(H256::random()),
        None,
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );

    // Wrong remote domain origin, but correct sender.
    let result = transfer_from_remote(
        initial_native_collateral_balance,
        remote_transfer_amount,
        None,
        Some(REMOTE_DOMAIN + 1),
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_process_authority_not_signer() {
    let program_id = hyperlane_sealevel_token_native_id();
    let mailbox_program_id = mailbox_id();

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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
                // 0.   `[signer]` Mailbox processor authority specific to this program.
                // 1.   `[executable]` system_program
                // 2.   `[]` hyperlane_token storage
                // 3.   `[writeable]` recipient wallet address
                // 4.   `[executable]` The system program.
                // 5.   `[writeable]` The native token collateral PDA account.
                AccountMeta::new_readonly(
                    hyperlane_token_accounts.mailbox_process_authority,
                    false,
                ),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new(recipient_pubkey, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
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
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        token.remote_routers,
        vec![(REMOTE_DOMAIN, remote_router)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_enroll_remote_router_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Use the mint authority as the payer, which has a balance but is not the owner,
    // so we expect this to fail.
    let result = enroll_remote_router(
        &mut banks_client,
        &program_id,
        &non_owner,
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
                AccountMeta::new_readonly(system_program::ID, false),
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
async fn test_set_destination_gas_configs() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        token.destination_gas,
        vec![(REMOTE_DOMAIN, gas)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_set_destination_gas_configs_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
                AccountMeta::new_readonly(system_program::ID, false),
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
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.owner, new_owner);
}

#[tokio::test]
async fn test_transfer_ownership_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let new_owner = Some(Pubkey::new_unique());
    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

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
}

#[tokio::test]
async fn test_set_interchain_security_module() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_security_module, new_ism);
}

#[tokio::test]
async fn test_set_interchain_security_module_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let new_ism = Some(Pubkey::new_unique());
    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Try setting the ISM using the non_owner key
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &HyperlaneTokenInstruction::SetInterchainSecurityModule(new_ism)
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
            &HyperlaneTokenInstruction::SetInterchainSecurityModule(new_ism)
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

#[tokio::test]
async fn test_set_interchain_gas_paymaster() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_gas_paymaster, new_igp);
}

#[tokio::test]
async fn test_set_interchain_gas_paymaster_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
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

// === Fee integration tests ===

const FEE_MAX: u64 = 1_000_000;
const FEE_HALF_AMOUNT: u64 = 500_000_000;

#[tokio::test]
async fn test_set_fee_config() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    // Verify fee_config is initially None.
    let account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);

    // Initialize a real fee account so SetFeeConfig validation passes.
    let fee_salt = H256::zero();
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            payer.pubkey(),
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
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config.
    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_account_key,
    };
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(fee_config.clone()))
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_config.fee_program, false),
                    AccountMeta::new_readonly(fee_config.fee_account, false),
                    AccountMeta::new_readonly(mailbox_accounts.outbox, false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify fee_config is set.
    let account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, Some(fee_config));

    // Unset fee config.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(None)
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify fee_config is None again.
    let account_data = banks_client
        .get_account(hyperlane_token_accounts.token)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);
}

#[tokio::test]
async fn test_transfer_remote_with_fee_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

    // Enroll remote router.
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

    // Initialize a Leaf fee account with on-chain Linear params.
    let fee_beneficiary = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: None, // on-chain only
    });
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            payer.pubkey(),
            fee_salt,
            fee_beneficiary,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config on the token.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(mailbox_outbox(), false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Fund fee beneficiary so it's rent-exempt (needed as lamport recipient).
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Fund the token sender.
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    // Standing quote PDAs (uninitialized, on-chain-only Leaf mode).
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
    // Transfer 10 SOL. With Linear(max_fee=1_000_000, half_amount=500_000_000):
    // fee = min(1_000_000, 10_000_000_000 * 1_000_000 / 1_000_000_000) = 1_000_000
    let transfer_amount = 10 * ONE_SOL_IN_LAMPORTS;
    let expected_fee = FEE_MAX; // amount >> half_amount, so fee is capped at max_fee

    let beneficiary_balance_before = banks_client.get_balance(fee_beneficiary).await.unwrap();
    let native_collateral_before = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

    // Account layout: Core -> Fee -> IGP -> Plugin
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: remote_token_recipient,
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    // Core
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // Fee section
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new(fee_beneficiary, false), // terminal
                    // IGP
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (native)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify collateral received the transfer amount.
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        native_collateral_before + transfer_amount,
    )
    .await;

    // Verify beneficiary received the exact expected fee.
    let beneficiary_balance_after = banks_client.get_balance(fee_beneficiary).await.unwrap();
    assert_eq!(
        beneficiary_balance_after - beneficiary_balance_before,
        expected_fee,
    );

    // Verify the dispatched message exists (mailbox dispatch succeeded).
    assert!(
        banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

#[tokio::test]
async fn test_transfer_remote_with_transient_quote_native() {
    fn encode_context(dest: u32, recipient: H256, amount: u64) -> Vec<u8> {
        let mut buf = Vec::with_capacity(44);
        buf.extend_from_slice(&dest.to_le_bytes());
        buf.extend_from_slice(recipient.as_bytes());
        buf.extend_from_slice(&amount.to_le_bytes());
        buf
    }
    fn encode_data(max_fee: u64, half_amount: u64) -> Vec<u8> {
        borsh::to_vec(&FeeDataStrategy::Linear(FeeParams {
            max_fee,
            half_amount,
        }))
        .unwrap()
    }

    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    // Init fee account with on-chain params: max_fee=1_000_000, half_amount=500_000_000.
    // These are HIGH so we can distinguish from the transient quote.
    let fee_beneficiary = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: Some(std::collections::BTreeSet::new()),
    });
    let fee_account_key = {
        let fp = fee_program_id();
        let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
        let ix = fee_instruction::init_fee_instruction(
            fp,
            payer.pubkey(),
            fee_salt,
            fee_beneficiary,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Add signer to fee account.
    let add_signer_ix = hyperlane_sealevel_fee::instruction::set_quote_signer_instruction(
        fee_program_id(),
        fee_account_key,
        payer.pubkey(),
        hyperlane_sealevel_fee::instruction::SetQuoteSignerOperation::Add(signer_address),
        None,
    )
    .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[add_signer_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Set fee config on the token.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(mailbox_outbox(), false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Fund token sender.
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();

    let remote_token_recipient = H256::random();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    // Submit a transient quote with DIFFERENT params: max_fee=500, half_amount=5_000_000_000.
    // On-chain Linear(1_000_000, 500_000_000) with amount=10 SOL => fee = 1_000_000 (capped).
    // Transient Linear(500, 5_000_000_000) with amount=10 SOL =>
    //   min(500, 10_000_000_000 * 500 / 10_000_000_000) = min(500, 500) = 500.
    let transient_max_fee: u64 = 500;
    let transient_half_amount: u64 = 5_000_000_000;
    let context = encode_context(REMOTE_DOMAIN, remote_token_recipient, transfer_amount);
    let data = encode_data(transient_max_fee, transient_half_amount);
    // issued_at must satisfy: now <= issued_at <= now + 300.
    // Use the current clock timestamp from the test validator.
    let clock: solana_program::clock::Clock = banks_client.get_sysvar().await.unwrap();
    let issued_at = encode_u48(clock.unix_timestamp);

    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at,
        expiry: issued_at, // transient: expiry == issued_at
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(&token_sender_pubkey);
    let message_hash = quote.build_message_hash(&fee_account_key, LOCAL_DOMAIN, &scoped_salt);
    quote.signature = sign_hash(&signing_key, message_hash.as_fixed_bytes());

    // Submit transient quote (payer = token_sender, since they'll be the QuoteFee payer).
    let submit_ix = hyperlane_sealevel_fee::instruction::submit_transient_quote_instruction(
        fee_program_id(),
        token_sender_pubkey,
        fee_account_key,
        scoped_salt,
        quote.clone(),
        &[],
    )
    .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[submit_ix],
            Some(&token_sender_pubkey),
            &[&token_sender],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let (transient_pda, _) = Pubkey::find_program_address(
        hyperlane_sealevel_fee::transient_quote_pda_seeds!(fee_account_key, scoped_salt),
        &fee_program_id(),
    );

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

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

    let beneficiary_balance_before = banks_client.get_balance(fee_beneficiary).await.unwrap();

    // Account layout: Core -> Fee (with transient PDA) -> IGP -> Plugin
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: remote_token_recipient,
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    // Core
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // Fee section (with transient PDA before standing quotes)
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new(transient_pda, false), // writable for autoclose
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new(fee_beneficiary, false), // terminal
                    // IGP
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (native)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify the fee matches the TRANSIENT quote params (500), not on-chain (1_000_000).
    let beneficiary_balance_after = banks_client.get_balance(fee_beneficiary).await.unwrap();
    let fee_collected = beneficiary_balance_after - beneficiary_balance_before;
    assert_eq!(
        fee_collected, transient_max_fee,
        "fee should come from transient quote (500), not on-chain (1_000_000)"
    );

    // Verify transient PDA was autoclosed.
    let transient_account = banks_client.get_account(transient_pda).await.unwrap();
    assert!(
        transient_account.is_none() || transient_account.unwrap().data.is_empty(),
        "transient PDA should be closed after consumption"
    );

    // Verify dispatch succeeded.
    assert!(
        banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

#[tokio::test]
async fn test_get_program_version() {
    use package_versioned::{get_program_version_instruction_data, PACKAGE_VERSION};
    use serializable_account_meta::SimulationReturnData;
    use solana_sdk::message::Message;

    let program_id = hyperlane_sealevel_token_native_id();
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

// === Negative fee tests ===

/// Shared setup for negative fee tests: initializes mailbox, IGP, token,
/// fee account, enrolls router, sets fee config, funds sender + beneficiary.
/// Returns all the keys needed to build transfer_remote account lists.
struct FeeTestContext {
    banks_client: BanksClient,
    program_id: Pubkey,
    mailbox_accounts: hyperlane_test_utils::MailboxAccounts,
    igp_accounts: IgpAccounts,
    hyperlane_token_accounts: HyperlaneTokenAccounts,
    fee_account_key: Pubkey,
    fee_beneficiary: Pubkey,
    token_sender: Keypair,
    domain_standing_quote_pda: Pubkey,
    wildcard_standing_quote_pda: Pubkey,
}

async fn setup_fee_test_context() -> FeeTestContext {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    let fee_beneficiary = Pubkey::new_unique();
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
            payer.pubkey(),
            fee_salt,
            fee_beneficiary,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            ))
            .await
            .unwrap();
        fee_account
    };

    // Set fee config.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(mailbox_outbox(), false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;

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

    FeeTestContext {
        banks_client,
        program_id,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        fee_account_key,
        fee_beneficiary,
        token_sender,
        domain_standing_quote_pda,
        wildcard_standing_quote_pda,
    }
}

#[tokio::test]
async fn test_set_fee_config_non_owner_fails() {
    let program_id = hyperlane_sealevel_token_native_id();
    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: Pubkey::new_unique(),
                    fee_account: Pubkey::new_unique(),
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
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
async fn test_transfer_remote_with_fee_wrong_fee_program() {
    let ctx = setup_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let wrong_fee_program = Pubkey::new_unique();

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(ctx.mailbox_accounts.program, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(
                        ctx.hyperlane_token_accounts.dispatch_authority,
                        false,
                    ),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    // Wrong fee program
                    AccountMeta::new_readonly(wrong_fee_program, false),
                    AccountMeta::new_readonly(ctx.fee_account_key, false),
                    AccountMeta::new_readonly(ctx.domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(ctx.wildcard_standing_quote_pda, false),
                    AccountMeta::new(ctx.fee_beneficiary, false),
                    // IGP
                    AccountMeta::new_readonly(ctx.igp_accounts.program, false),
                    AccountMeta::new(ctx.igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.igp_accounts.overhead_igp, false),
                    AccountMeta::new(ctx.igp_accounts.igp, false),
                    // Plugin
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(ctx.hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&ctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;

    // fee_program key mismatch → InvalidArgument
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_fee_config_wrong_fee_account_owner() {
    let program_id = hyperlane_sealevel_token_native_id();
    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    // The token PDA exists but is owned by the token program, not the fee program.
    let wrong_fee_account = hyperlane_token_accounts.token;
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: wrong_fee_account,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(wrong_fee_account, false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await;

    // Fee account is not owned by fee program → InvalidArgument.
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_transfer_remote_with_fee_missing_beneficiary() {
    let ctx = setup_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );
    // Omit the fee beneficiary terminal from the account list entirely.
    // The parser should exhaust accounts or hit the cap and error.
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(ctx.hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(ctx.mailbox_accounts.program, false),
                    AccountMeta::new(ctx.mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(
                        ctx.hyperlane_token_accounts.dispatch_authority,
                        false,
                    ),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    // Fee section WITHOUT beneficiary terminal
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(ctx.fee_account_key, false),
                    AccountMeta::new_readonly(ctx.domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(ctx.wildcard_standing_quote_pda, false),
                    // NO fee_beneficiary — terminal is missing
                ],
            )],
            Some(&token_sender_pubkey),
            &[&ctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;

    // Iterator runs out of accounts before finding the terminal.
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
    let ctx = setup_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );

    // Stuff 16+ dummy accounts that don't match the terminal beneficiary.
    // This should trigger the FeeBeneficiaryNotFound cap (max 15 variable accounts).
    let mut accounts = vec![
        // Core
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new_readonly(ctx.hyperlane_token_accounts.token, false),
        AccountMeta::new_readonly(ctx.mailbox_accounts.program, false),
        AccountMeta::new(ctx.mailbox_accounts.outbox, false),
        AccountMeta::new_readonly(ctx.hyperlane_token_accounts.dispatch_authority, false),
        AccountMeta::new_readonly(token_sender_pubkey, true),
        AccountMeta::new_readonly(unique_msg.pubkey(), true),
        AccountMeta::new(dispatched_msg_key, false),
        // Fee section start
        AccountMeta::new_readonly(fee_program_id(), false),
        AccountMeta::new_readonly(ctx.fee_account_key, false),
    ];
    // 16 dummy accounts — none match the expected beneficiary
    for _ in 0..16 {
        accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
    }

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let result = ctx
        .banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                ctx.program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                accounts,
            )],
            Some(&token_sender_pubkey),
            &[&ctx.token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await;

    // Custom(6) = FeeBeneficiaryNotFound
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(6)),
    );
}

#[tokio::test]
async fn test_transfer_remote_with_fee_routing_mode() {
    use hyperlane_sealevel_fee::accounts::RoutingFeeConfig;

    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    // Init fee account with ROUTING mode (no on-chain Leaf params).
    let fee_beneficiary = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Routing(RoutingFeeConfig {
        wildcard_signers: std::collections::BTreeSet::new(),
    });
    let fp = fee_program_id();
    let (fee_account_key, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);
    let ix = fee_instruction::init_fee_instruction(
        fp,
        payer.pubkey(),
        fee_salt,
        fee_beneficiary,
        fee_data,
        LOCAL_DOMAIN,
    )
    .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Set a route for REMOTE_DOMAIN with specific fee params.
    let route_max_fee: u64 = 2_000_000;
    let route_half_amount: u64 = 1_000_000_000;
    let set_route_ix = fee_instruction::set_remote_fee_route_instruction(
        fp,
        fee_account_key,
        payer.pubkey(),
        REMOTE_DOMAIN,
        None,
        FeeDataStrategy::Linear(FeeParams {
            max_fee: route_max_fee,
            half_amount: route_half_amount,
        }),
        None,
    )
    .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[set_route_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Set fee config on the token.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fp,
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(mailbox_outbox(), false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    // Derive PDAs for Routing-mode QuoteFee.
    let domain_standing_quote_pda = {
        let domain_le = REMOTE_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fp,
        );
        pda
    };
    let wildcard_standing_quote_pda = {
        let domain_le = WILDCARD_DOMAIN.to_le_bytes();
        let (pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(&fee_account_key, &domain_le),
            &fp,
        );
        pda
    };
    let route_pda = {
        let domain_le = REMOTE_DOMAIN.to_le_bytes();
        let (pda, _) =
            Pubkey::find_program_address(route_domain_pda_seeds!(fee_account_key, &domain_le), &fp);
        pda
    };

    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;
    // Linear(max_fee=2_000_000, half_amount=1_000_000_000), amount=10 SOL:
    // fee = min(2_000_000, 10_000_000_000 * 2_000_000 / 2_000_000_000) = min(2_000_000, 10_000_000) = 2_000_000
    let expected_fee = route_max_fee;

    let beneficiary_balance_before = banks_client.get_balance(fee_beneficiary).await.unwrap();

    // Account layout: Core -> Fee (with route PDA) -> IGP -> Plugin
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    // Core
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // Fee section (Routing: standing quotes + route PDA)
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new_readonly(route_pda, false),
                    AccountMeta::new(fee_beneficiary, false), // terminal
                    // IGP
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (native)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify beneficiary received exact fee from route params.
    let beneficiary_balance_after = banks_client.get_balance(fee_beneficiary).await.unwrap();
    assert_eq!(
        beneficiary_balance_after - beneficiary_balance_before,
        expected_fee,
    );

    // Verify dispatch succeeded.
    assert!(
        banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

// ========================================================================
// IGP new flow tests (native token)
// ========================================================================

/// IGP new flow with standing quote, no fees. Verifies quote pricing on
/// native token and that the transient PDA autoclose doesn't break
/// native SOL transfers.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_standing_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    // --- IGP quoting setup ---
    let igp_signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    // Submit a standing IGP quote with custom pricing.
    let igp_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let igp_gas_price: u128 = 5;
    let igp_token_decimals: u8 = 9;
    submit_standing_igp_quote(
        &mut banks_client,
        &payer,
        &igp_accounts.igp,
        &igp_signing_key,
        REMOTE_DOMAIN,
        &program_id,
        igp_exchange_rate,
        igp_gas_price,
        igp_token_decimals,
    )
    .await;

    let exact_standing_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );
    let ws_standing_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
    );
    let wd_standing_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        IGP_WILDCARD_DOMAIN,
        &program_id,
    );

    // --- TransferRemote with IGP new flow (no fees) ---
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    // Core (0-8)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // IGP new flow (no fee section — fee_config is None)
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new_readonly(exact_standing_pda, false),
                    AccountMeta::new_readonly(ws_standing_pda, false),
                    AccountMeta::new_readonly(wd_standing_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false), // TERMINAL
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (native)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify IGP used quote pricing.
    let expected_igp_payment: u64 = {
        let dest_cost = (REMOTE_GAS_AMOUNT as u128) * igp_gas_price;
        let origin_cost = dest_cost * igp_exchange_rate / TOKEN_EXCHANGE_RATE_SCALE;
        origin_cost as u64
    };
    assert_ne!(
        expected_igp_payment, REMOTE_GAS_AMOUNT,
        "quote payment should differ from oracle"
    );

    let gas_payment_account_data = banks_client
        .get_account(gas_payment_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let gas_payment = GasPaymentAccount::fetch(&mut &gas_payment_account_data[..])
        .unwrap()
        .into_inner();

    assert_eq!(gas_payment.data.payment, expected_igp_payment);
    assert_eq!(gas_payment.data.gas_amount, REMOTE_GAS_AMOUNT);

    // Verify dispatch succeeded.
    assert!(
        banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

/// IGP new flow with transient quote on native token, no fees.
/// Isolates whether the IGP transient autoclose works with native SOL transfers.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_transient_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    // IGP quoting setup.
    let igp_signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    // Fund sender.
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    // Build IGP transient quote.
    let clock: solana_program::clock::Clock = banks_client.get_sysvar().await.unwrap();
    let issued_at = encode_u48(clock.unix_timestamp);

    let igp_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let igp_gas_price: u128 = 5;
    let igp_context = encode_igp_context(&Pubkey::default(), REMOTE_DOMAIN, &program_id);
    let igp_data_bytes = encode_igp_data(igp_exchange_rate, igp_gas_price, 9);

    let mut igp_quote = SvmSignedQuote {
        context: igp_context,
        data: igp_data_bytes,
        issued_at,
        expiry: issued_at, // transient
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let igp_scoped_salt = igp_quote.compute_scoped_salt(&token_sender_pubkey);
    let igp_msg_hash =
        igp_quote.build_message_hash(&igp_accounts.igp, IGP_DOMAIN_ID, &igp_scoped_salt);
    igp_quote.signature = sign_hash(&igp_signing_key, igp_msg_hash.as_fixed_bytes());

    let (igp_transient_pda, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(&igp_accounts.igp, igp_scoped_salt),
        &igp_program_id(),
    );

    // Submit transient quote.
    let igp_submit_ix = submit_igp_quote_instruction(
        igp_program_id(),
        token_sender_pubkey,
        igp_accounts.igp,
        igp_transient_pda,
        igp_quote,
    )
    .unwrap();
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[igp_submit_ix],
            Some(&token_sender_pubkey),
            &[&token_sender],
            bh,
        ))
        .await
        .unwrap();

    // TransferRemote with IGP transient (no fees).
    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: transfer_amount.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    // Core
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_message_key, false),
                    // IGP new flow (no fee section)
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new(igp_transient_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false), // TERMINAL
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (native)
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    // Verify quote pricing used.
    let expected_igp_payment: u64 = {
        let dest_cost = (REMOTE_GAS_AMOUNT as u128) * igp_gas_price;
        let origin_cost = dest_cost * igp_exchange_rate / TOKEN_EXCHANGE_RATE_SCALE;
        origin_cost as u64
    };
    assert_ne!(expected_igp_payment, REMOTE_GAS_AMOUNT);

    let gas_payment_account_data = banks_client
        .get_account(gas_payment_pda_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let gas_payment = GasPaymentAccount::fetch(&mut &gas_payment_account_data[..])
        .unwrap()
        .into_inner();

    assert_eq!(gas_payment.data.payment, expected_igp_payment);
    assert_eq!(gas_payment.data.gas_amount, REMOTE_GAS_AMOUNT);

    // Verify transient PDA autoclosed.
    let igp_transient_account = banks_client.get_account(igp_transient_pda).await.unwrap();
    assert!(
        igp_transient_account.is_none() || igp_transient_account.unwrap().data.is_empty(),
        "IGP transient PDA should be closed"
    );
}

/// Fully transient: both fee program AND IGP use transient quotes on native.
/// Three transactions: submit fee transient, submit IGP transient, transfer_remote.
/// Verifies fee pricing from transient (not on-chain), IGP pricing from transient
/// (not oracle), both PDAs autoclosed, and dispatch succeeded.
#[tokio::test]
async fn test_transfer_remote_fully_transient_fee_and_igp_native() {
    fn encode_fee_context(dest: u32, recipient: H256, amount: u64) -> Vec<u8> {
        let mut buf = Vec::with_capacity(44);
        buf.extend_from_slice(&dest.to_le_bytes());
        buf.extend_from_slice(recipient.as_bytes());
        buf.extend_from_slice(&amount.to_le_bytes());
        buf
    }
    fn encode_fee_data(max_fee: u64, half_amount: u64) -> Vec<u8> {
        borsh::to_vec(&FeeDataStrategy::Linear(FeeParams {
            max_fee,
            half_amount,
        }))
        .unwrap()
    }

    let program_id = hyperlane_sealevel_token_native_id();
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

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();

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

    // === Fee program setup ===
    let fee_signing_key = SigningKey::random(&mut rand::thread_rng());
    let fee_signer_address = eth_address(&fee_signing_key);
    let fee_beneficiary = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fee_data = FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: FEE_MAX,
            half_amount: FEE_HALF_AMOUNT,
        }),
        signers: Some(std::collections::BTreeSet::new()),
    });
    let fee_account_key = {
        let (k, _) =
            Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fee_program_id());
        let ix = fee_instruction::init_fee_instruction(
            fee_program_id(),
            payer.pubkey(),
            fee_salt,
            fee_beneficiary,
            fee_data,
            LOCAL_DOMAIN,
        )
        .unwrap();
        let bh = banks_client.get_latest_blockhash().await.unwrap();
        banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[ix],
                Some(&payer.pubkey()),
                &[&payer],
                bh,
            ))
            .await
            .unwrap();
        k
    };

    // Add fee signer.
    let ix = hyperlane_sealevel_fee::instruction::set_quote_signer_instruction(
        fee_program_id(),
        fee_account_key,
        payer.pubkey(),
        hyperlane_sealevel_fee::instruction::SetQuoteSignerOperation::Add(fee_signer_address),
        None,
    )
    .unwrap();
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        ))
        .await
        .unwrap();

    // Set fee config on token.
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::SetFeeConfig(Some(FeeConfig {
                    fee_program: fee_program_id(),
                    fee_account: fee_account_key,
                }))
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.token, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(mailbox_outbox(), false),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        ))
        .await
        .unwrap();

    // Fund fee beneficiary for rent exemption.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // === IGP quoting setup ===
    let igp_signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    // === Fund sender ===
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();
    let remote_token_recipient = H256::random();
    let transfer_amount: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let clock: solana_program::clock::Clock = banks_client.get_sysvar().await.unwrap();
    let now = clock.unix_timestamp;
    let issued_at = encode_u48(now);

    // === TX 1: Submit fee transient quote ===
    let transient_fee_max: u64 = 500;
    let transient_fee_half: u64 = 5_000_000_000;
    let fee_context = encode_fee_context(REMOTE_DOMAIN, remote_token_recipient, transfer_amount);
    let fee_data_bytes = encode_fee_data(transient_fee_max, transient_fee_half);

    let mut fee_quote = SvmSignedQuote {
        context: fee_context,
        data: fee_data_bytes,
        issued_at,
        expiry: issued_at, // transient
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let fee_scoped_salt = fee_quote.compute_scoped_salt(&token_sender_pubkey);
    let fee_msg_hash =
        fee_quote.build_message_hash(&fee_account_key, LOCAL_DOMAIN, &fee_scoped_salt);
    fee_quote.signature = sign_hash(&fee_signing_key, fee_msg_hash.as_fixed_bytes());

    let fee_submit_ix = hyperlane_sealevel_fee::instruction::submit_transient_quote_instruction(
        fee_program_id(),
        token_sender_pubkey,
        fee_account_key,
        fee_scoped_salt,
        fee_quote,
        &[],
    )
    .unwrap();
    let (fee_transient_pda, _) = Pubkey::find_program_address(
        hyperlane_sealevel_fee::transient_quote_pda_seeds!(fee_account_key, fee_scoped_salt),
        &fee_program_id(),
    );

    // === IGP transient quote ===
    let igp_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let igp_gas_price: u128 = 5;
    let igp_context = encode_igp_context(&Pubkey::default(), REMOTE_DOMAIN, &program_id);
    let igp_data_bytes = encode_igp_data(igp_exchange_rate, igp_gas_price, 9);

    let mut igp_quote = SvmSignedQuote {
        context: igp_context,
        data: igp_data_bytes,
        issued_at,
        expiry: issued_at, // transient
        client_salt: H256::random(),
        signature: [0u8; 65],
    };
    let igp_scoped_salt = igp_quote.compute_scoped_salt(&token_sender_pubkey);
    let igp_msg_hash =
        igp_quote.build_message_hash(&igp_accounts.igp, IGP_DOMAIN_ID, &igp_scoped_salt);
    igp_quote.signature = sign_hash(&igp_signing_key, igp_msg_hash.as_fixed_bytes());

    let (igp_transient_pda, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(&igp_accounts.igp, igp_scoped_salt),
        &igp_program_id(),
    );
    let igp_submit_ix = submit_igp_quote_instruction(
        igp_program_id(),
        token_sender_pubkey,
        igp_accounts.igp,
        igp_transient_pda,
        igp_quote,
    )
    .unwrap();

    // === Single TX: both transient submits + TransferRemote ===
    let unique_msg = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );
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

    let beneficiary_balance_before = banks_client.get_balance(fee_beneficiary).await.unwrap();

    let transfer_ix = Instruction::new_with_bytes(
        program_id,
        &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
            destination_domain: REMOTE_DOMAIN,
            recipient: remote_token_recipient,
            amount_or_id: transfer_amount.into(),
        })
        .encode()
        .unwrap(),
        vec![
            // Core
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
            AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
            AccountMeta::new_readonly(mailbox_accounts.program, false),
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
            AccountMeta::new_readonly(token_sender_pubkey, true),
            AccountMeta::new_readonly(unique_msg.pubkey(), true),
            AccountMeta::new(dispatched_message_key, false),
            // Fee section (transient)
            AccountMeta::new_readonly(fee_program_id(), false),
            AccountMeta::new_readonly(fee_account_key, false),
            AccountMeta::new(fee_transient_pda, false),
            AccountMeta::new_readonly(domain_standing_quote_pda, false),
            AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
            AccountMeta::new(fee_beneficiary, false), // terminal
            // IGP new flow (transient)
            AccountMeta::new_readonly(igp_accounts.program, false),
            AccountMeta::new(igp_accounts.program_data, false),
            AccountMeta::new(gas_payment_pda_key, false),
            AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
            AccountMeta::new_readonly(program_id, false),
            AccountMeta::new(igp_transient_pda, false),
            AccountMeta::new_readonly(igp_accounts.overhead_igp, false), // TERMINAL
            AccountMeta::new(igp_accounts.igp, false),
            // Plugin (native)
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
        ],
    );

    // All 3 instructions in one transaction: submit fee transient,
    // submit IGP transient, transfer_remote consuming both.
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[fee_submit_ix, igp_submit_ix, transfer_ix],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            bh,
        ))
        .await
        .unwrap();

    // === Verify fee from transient quote ===
    let beneficiary_balance_after = banks_client.get_balance(fee_beneficiary).await.unwrap();
    let fee_collected = beneficiary_balance_after - beneficiary_balance_before;
    assert_eq!(
        fee_collected, transient_fee_max,
        "fee should come from transient quote ({transient_fee_max}), not on-chain ({FEE_MAX})"
    );

    // === Verify fee transient PDA autoclosed ===
    let acct = banks_client.get_account(fee_transient_pda).await.unwrap();
    assert!(
        acct.is_none() || acct.unwrap().data.is_empty(),
        "fee transient PDA should be closed"
    );

    // === Verify IGP from transient quote ===
    let expected_igp_payment: u64 = {
        let dest_cost = (REMOTE_GAS_AMOUNT as u128) * igp_gas_price;
        (dest_cost * igp_exchange_rate / TOKEN_EXCHANGE_RATE_SCALE) as u64
    };
    assert_ne!(expected_igp_payment, REMOTE_GAS_AMOUNT, "quote != oracle");

    let gp = GasPaymentAccount::fetch(
        &mut &banks_client
            .get_account(gas_payment_pda_key)
            .await
            .unwrap()
            .unwrap()
            .data[..],
    )
    .unwrap()
    .into_inner();
    assert_eq!(gp.data.payment, expected_igp_payment);
    assert_eq!(gp.data.gas_amount, REMOTE_GAS_AMOUNT);

    // === Verify IGP transient PDA autoclosed ===
    let acct = banks_client.get_account(igp_transient_pda).await.unwrap();
    assert!(
        acct.is_none() || acct.unwrap().data.is_empty(),
        "IGP transient PDA should be closed"
    );

    // === Verify dispatch ===
    assert!(
        banks_client
            .get_account(dispatched_message_key)
            .await
            .unwrap()
            .is_some(),
        "dispatched message should exist"
    );
}

// ========================================================================
// IGP new flow: shared helpers
// ========================================================================

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

#[allow(clippy::too_many_arguments)]
fn make_signed_igp_quote(
    signing_key: &SigningKey,
    igp_key: &Pubkey,
    domain_id: u32,
    payer: &Pubkey,
    context: Vec<u8>,
    data: Vec<u8>,
    issued_at: i64,
    expiry: i64,
) -> SvmSignedQuote {
    let client_salt = H256::random();
    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at: encode_u48(issued_at),
        expiry: encode_u48(expiry),
        client_salt,
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(payer);
    let message_hash = quote.build_message_hash(igp_key, domain_id, &scoped_salt);
    quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());
    quote
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

/// Enables IGP quoting and adds a signer. Returns the signing key.
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
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
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
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    signing_key
}

/// Submits a standing IGP quote for (dest_domain, sender) with given pricing.
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

    let quote = make_signed_igp_quote(
        signing_key,
        igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        now,
        now + 3600,
    );

    let quote_pda = derive_igp_standing_quote_pda(igp_key, &fee_token_mint, dest_domain, sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), *igp_key, quote_pda, quote)
            .unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        ))
        .await
        .unwrap();
}

// ========================================================================
// IGP new flow: stricter assertion helper + tests
// ========================================================================

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

    let dispatched_message = hyperlane_sealevel_mailbox::accounts::DispatchedMessageAccount::fetch(
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

/// Cascade: exact PDA uninitialized, wildcard-sender resolves.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_cascade_wildcard_sender_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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
    let hta =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hta.token,
        REMOTE_DOMAIN,
        H256::random(),
    )
    .await
    .unwrap();

    // IGP quoting.
    let signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    let qer = 3 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 7;
    // Submit wildcard-sender quote.
    submit_standing_igp_quote(
        &mut banks_client,
        &payer,
        &igp_accounts.igp,
        &signing_key,
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
        qer,
        qgp,
        9,
    )
    .await;
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
    );

    let exact_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        IGP_WILDCARD_DOMAIN,
        &program_id,
    );
    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let tsp = token_sender.pubkey();
    let um = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&um.pubkey()),
        &mailbox_id(),
    );
    let (gp, _) =
        Pubkey::find_program_address(igp_gas_payment_pda_seeds!(&um.pubkey()), &igp_program_id());
    let ta: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: ta.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hta.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(tsp, true),
                    AccountMeta::new_readonly(um.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hta.native_collateral, false),
                ],
            )],
            Some(&tsp),
            &[&token_sender, &um],
            bh,
        ))
        .await
        .unwrap();

    let ep = ((REMOTE_GAS_AMOUNT as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut banks_client,
        gp,
        dm,
        igp_accounts.igp,
        REMOTE_DOMAIN,
        um.pubkey(),
        REMOTE_GAS_AMOUNT,
        ep,
    )
    .await;
}

/// Cascade: all 3 uninitialized, falls back to oracle.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_cascade_oracle_fallback_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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
    let hta =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hta.token,
        REMOTE_DOMAIN,
        H256::random(),
    )
    .await
    .unwrap();

    // Enable quoting but don't submit any quotes.
    let _signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    let exact_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        IGP_WILDCARD_DOMAIN,
        &program_id,
    );

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let tsp = token_sender.pubkey();
    let um = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&um.pubkey()),
        &mailbox_id(),
    );
    let (gp, _) =
        Pubkey::find_program_address(igp_gas_payment_pda_seeds!(&um.pubkey()), &igp_program_id());
    let ta: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: ta.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hta.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(tsp, true),
                    AccountMeta::new_readonly(um.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hta.native_collateral, false),
                ],
            )],
            Some(&tsp),
            &[&token_sender, &um],
            bh,
        ))
        .await
        .unwrap();

    assert_igp_gas_payment(
        &mut banks_client,
        gp,
        dm,
        igp_accounts.igp,
        REMOTE_DOMAIN,
        um.pubkey(),
        REMOTE_GAS_AMOUNT,
        REMOTE_GAS_AMOUNT,
    )
    .await;
}

/// OverheadIgp with gas overhead applies to quoted payment.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_with_overhead_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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
    let hta =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hta.token,
        REMOTE_DOMAIN,
        H256::random(),
    )
    .await
    .unwrap();

    // Set gas overhead.
    let gas_overhead: u64 = 100_000;
    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_borsh(
                igp_program_id(),
                &IgpProgramInstruction::SetDestinationGasOverheads(vec![GasOverheadConfig {
                    destination_domain: REMOTE_DOMAIN,
                    gas_overhead: Some(gas_overhead),
                }]),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(igp_accounts.overhead_igp, false),
                    AccountMeta::new_readonly(payer.pubkey(), true),
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            bh,
        ))
        .await
        .unwrap();

    // IGP quoting.
    let signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    let qer = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 5;
    submit_standing_igp_quote(
        &mut banks_client,
        &payer,
        &igp_accounts.igp,
        &signing_key,
        REMOTE_DOMAIN,
        &program_id,
        qer,
        qgp,
        9,
    )
    .await;

    let exact_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
    );
    let wd_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        IGP_WILDCARD_DOMAIN,
        &program_id,
    );

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let tsp = token_sender.pubkey();
    let um = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&um.pubkey()),
        &mailbox_id(),
    );
    let (gp, _) =
        Pubkey::find_program_address(igp_gas_payment_pda_seeds!(&um.pubkey()), &igp_program_id());
    let ta: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: ta.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hta.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(tsp, true),
                    AccountMeta::new_readonly(um.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hta.native_collateral, false),
                ],
            )],
            Some(&tsp),
            &[&token_sender, &um],
            bh,
        ))
        .await
        .unwrap();

    let expected_gas = REMOTE_GAS_AMOUNT + gas_overhead;
    let ep = ((expected_gas as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut banks_client,
        gp,
        dm,
        igp_accounts.igp,
        REMOTE_DOMAIN,
        um.pubkey(),
        expected_gas,
        ep,
    )
    .await;
}

/// Cascade: exact + ws uninitialized, wildcard-domain resolves.
#[tokio::test]
async fn test_transfer_remote_igp_new_flow_cascade_wildcard_domain_native() {
    let program_id = hyperlane_sealevel_token_native_id();
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
    let hta =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, Some(&igp_accounts))
            .await
            .unwrap();
    enroll_remote_router(
        &mut banks_client,
        &program_id,
        &payer,
        &hta.token,
        REMOTE_DOMAIN,
        H256::random(),
    )
    .await
    .unwrap();

    // IGP quoting.
    let signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    let qer = 4 * TOKEN_EXCHANGE_RATE_SCALE;
    let qgp: u128 = 3;
    // Submit wildcard-domain quote only.
    submit_standing_igp_quote(
        &mut banks_client,
        &payer,
        &igp_accounts.igp,
        &signing_key,
        IGP_WILDCARD_DOMAIN,
        &program_id,
        qer,
        qgp,
        9,
    )
    .await;

    let wd_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        IGP_WILDCARD_DOMAIN,
        &program_id,
    );
    let exact_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );
    let ws_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &WILDCARD_SENDER,
    );

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 100 * ONE_SOL_IN_LAMPORTS).await;
    let tsp = token_sender.pubkey();
    let um = Keypair::new();
    let (dm, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&um.pubkey()),
        &mailbox_id(),
    );
    let (gp, _) =
        Pubkey::find_program_address(igp_gas_payment_pda_seeds!(&um.pubkey()), &igp_program_id());
    let ta: u64 = 10 * ONE_SOL_IN_LAMPORTS;

    let bh = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[Instruction::new_with_bytes(
                program_id,
                &HyperlaneTokenInstruction::TransferRemote(TransferRemote {
                    destination_domain: REMOTE_DOMAIN,
                    recipient: H256::random(),
                    amount_or_id: ta.into(),
                })
                .encode()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hta.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(tsp, true),
                    AccountMeta::new_readonly(um.pubkey(), true),
                    AccountMeta::new(dm, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gp, false),
                    AccountMeta::new_readonly(hta.dispatch_authority, false),
                    AccountMeta::new_readonly(program_id, false),
                    AccountMeta::new_readonly(exact_pda, false),
                    AccountMeta::new_readonly(ws_pda, false),
                    AccountMeta::new_readonly(wd_pda, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hta.native_collateral, false),
                ],
            )],
            Some(&tsp),
            &[&token_sender, &um],
            bh,
        ))
        .await
        .unwrap();

    let ep = ((REMOTE_GAS_AMOUNT as u128) * qgp * qer / TOKEN_EXCHANGE_RATE_SCALE) as u64;
    assert_igp_gas_payment(
        &mut banks_client,
        gp,
        dm,
        igp_accounts.igp,
        REMOTE_DOMAIN,
        um.pubkey(),
        REMOTE_GAS_AMOUNT,
        ep,
    )
    .await;
}
