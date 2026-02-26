//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use hyperlane_sealevel_fee::{
    accounts::FeeData,
    fee_route_pda_seeds,
    instruction::{init_fee_instruction, set_route_instruction},
    processor::process_instruction as fee_process_instruction,
};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;
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
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, FeeConfig, HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{
        set_fee_config_instruction, Init, Instruction as HyperlaneTokenInstruction, TransferRemote,
    },
};
use hyperlane_sealevel_token_native::{
    hyperlane_token_native_collateral_pda_seeds, plugin::NativePlugin,
    processor::process_instruction,
};
use hyperlane_test_utils::{
    assert_lamports, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process,
    process_instruction as process_instruction_helper, transfer_lamports, IgpAccounts,
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

fn hyperlane_sealevel_token_native_id() -> Pubkey {
    pubkey!("CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga")
}

fn fee_program_id() -> Pubkey {
    pubkey!("FEEaJQp2jSHEkM5njByhKfK7fZoz3kJpk4MaJoYBe1t5")
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

    program_test.add_program(
        "hyperlane_sealevel_fee",
        fee_program_id(),
        processor!(fee_process_instruction),
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
                fee_config: None,
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

// ==== Fee integration tests ====

/// Helper: initialize a fee account on the fee program.
async fn init_fee_account(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> Pubkey {
    let ixn = init_fee_instruction(
        fee_program_id(),
        payer.pubkey(),
        salt,
        beneficiary,
        fee_data,
    )
    .unwrap();
    let fee_key = ixn.accounts[1].pubkey;
    process_instruction_helper(banks_client, ixn, payer, &[payer])
        .await
        .unwrap();
    fee_key
}

/// Helper: set fee config on the warp route token.
async fn set_fee_config(
    banks_client: &mut BanksClient,
    program_id: &Pubkey,
    payer: &Keypair,
    fee_config: Option<FeeConfig>,
) {
    let ixn = set_fee_config_instruction(*program_id, payer.pubkey(), fee_config).unwrap();
    process_instruction_helper(banks_client, ixn, payer, &[payer])
        .await
        .unwrap();
}

#[tokio::test]
async fn test_set_fee_config() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
        .await
        .unwrap();

    let salt = H256::zero();
    let fee_data = FeeData::Linear {
        max_fee: 1_000_000,
        half_amount: 500_000,
    };
    let fee_beneficiary = Pubkey::new_unique();
    let fee_key =
        init_fee_account(&mut banks_client, &payer, salt, fee_beneficiary, fee_data).await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };

    set_fee_config(
        &mut banks_client,
        &program_id,
        &payer,
        Some(fee_config.clone()),
    )
    .await;

    // Verify it was stored
    let (token_key, _) = Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);
    let token_account_data = banks_client
        .get_account(token_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, Some(fee_config));
}

#[tokio::test]
async fn test_set_fee_config_clear() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
        .await
        .unwrap();

    // Create a fee account
    let salt = H256::zero();
    let fee_data = FeeData::Linear {
        max_fee: 1_000_000,
        half_amount: 500_000,
    };
    let fee_beneficiary = Pubkey::new_unique();
    let fee_key =
        init_fee_account(&mut banks_client, &payer, salt, fee_beneficiary, fee_data).await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };

    // Set fee config, then clear it
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;
    set_fee_config(&mut banks_client, &program_id, &payer, None).await;

    // Verify it was cleared
    let (token_key, _) = Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);
    let token_account_data = banks_client
        .get_account(token_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    let token = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);
}

#[tokio::test]
async fn test_set_fee_config_errors_if_not_owner() {
    let program_id = hyperlane_sealevel_token_native_id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
        .await
        .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: Pubkey::new_unique(),
    };

    // Build the instruction manually with non_owner
    let ixn = set_fee_config_instruction(program_id, non_owner.pubkey(), Some(fee_config)).unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_transfer_remote_with_linear_fee() {
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

    // Enroll remote router
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

    // For native tokens, fee beneficiary is a direct wallet address (not an ATA).
    let fee_beneficiary_wallet = Pubkey::new_unique();

    // Initialize fee account with Linear fee
    let salt = H256::zero();
    let max_fee: u64 = 200_000_000; // 0.2 SOL
    let half_amount: u64 = 50 * ONE_SOL_IN_LAMPORTS; // 50 SOL
    let fee_data = FeeData::Linear {
        max_fee,
        half_amount,
    };
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        salt,
        fee_beneficiary_wallet,
        fee_data,
    )
    .await;

    // Fund the fee beneficiary to make it rent-exempt (system accounts need some lamports to exist)
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary_wallet,
        ONE_SOL_IN_LAMPORTS / 100, // small amount
    )
    .await;
    let fee_beneficiary_balance_before = banks_client
        .get_balance(fee_beneficiary_wallet)
        .await
        .unwrap();

    // Set fee config on the warp route
    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

    // Create token sender with 100 SOL
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

    let transfer_amount = 69 * ONE_SOL_IN_LAMPORTS;

    // Compute expected fee: Linear = min(max_fee, amount * max_fee / (2 * half_amount))
    let expected_fee: u64 = {
        let a = transfer_amount as u128;
        let m = max_fee as u128;
        let h = half_amount as u128;
        let linear = (a * m) / (2 * h);
        std::cmp::min(max_fee as u128, linear) as u64
    };
    // 69_000_000_000 * 200_000_000 / (2 * 50_000_000_000) = 138_000_000
    assert_eq!(expected_fee, 138_000_000);

    let sender_balance_before = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let native_collateral_before = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                // 0-8: standard accounts
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // Fee accounts (Linear: 0 additional accounts)
                AccountMeta::new_readonly(fee_program_id(), false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(fee_beneficiary_wallet, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts (native): system_program, native_collateral
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

    banks_client.process_transaction(transaction).await.unwrap();

    // Verify native collateral received transfer_amount (not transfer_amount + fee)
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        native_collateral_before + transfer_amount,
    )
    .await;

    // Verify fee beneficiary received fee lamports
    assert_lamports(
        &mut banks_client,
        &fee_beneficiary_wallet,
        fee_beneficiary_balance_before + expected_fee,
    )
    .await;

    // Verify sender balance: roughly initial - transfer_amount - fee - tx_fees - igp
    let sender_balance_after = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let expected_max = sender_balance_before - transfer_amount - expected_fee - transaction_fee;
    // Allow tolerance for tx fees
    assert!(
        sender_balance_after >= expected_max - 5_000_000 && sender_balance_after <= expected_max
    );
}

#[tokio::test]
async fn test_transfer_remote_with_zero_fee() {
    // When fee computes to 0 (half_amount=0), transfer_remote should succeed with no fee deduction.
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

    // Fee with half_amount=0 → fee is 0
    let fee_data = FeeData::Linear {
        max_fee: 200_000_000,
        half_amount: 0,
    };
    let fee_beneficiary_wallet = Pubkey::new_unique();
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        fee_beneficiary_wallet,
        fee_data,
    )
    .await;

    // Fund the fee beneficiary so it exists
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary_wallet,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;
    let fee_beneficiary_balance_before = banks_client
        .get_balance(fee_beneficiary_wallet)
        .await
        .unwrap();

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

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

    let transfer_amount = 10 * ONE_SOL_IN_LAMPORTS;

    let sender_balance_before = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let native_collateral_before = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // Fee accounts
                AccountMeta::new_readonly(fee_program_id(), false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(fee_beneficiary_wallet, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts (native)
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

    banks_client.process_transaction(transaction).await.unwrap();

    // Fee is 0, so collateral gets only transfer_amount
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        native_collateral_before + transfer_amount,
    )
    .await;

    // Fee beneficiary balance unchanged
    assert_lamports(
        &mut banks_client,
        &fee_beneficiary_wallet,
        fee_beneficiary_balance_before,
    )
    .await;

    // Sender paid only transfer_amount + tx fees (no fee deduction)
    let sender_balance_after = banks_client.get_balance(token_sender_pubkey).await.unwrap();
    let expected_max = sender_balance_before - transfer_amount - transaction_fee;
    assert!(
        sender_balance_after >= expected_max - 5_000_000 && sender_balance_after <= expected_max
    );
}

#[tokio::test]
async fn test_transfer_remote_with_wrong_fee_beneficiary() {
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

    let fee_data = FeeData::Linear {
        max_fee: 200_000_000,
        half_amount: 50 * ONE_SOL_IN_LAMPORTS,
    };
    let fee_beneficiary_wallet = Pubkey::new_unique();
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        fee_beneficiary_wallet,
        fee_data,
    )
    .await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

    // Use a WRONG fee beneficiary
    let wrong_fee_beneficiary = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &wrong_fee_beneficiary,
        ONE_SOL_IN_LAMPORTS / 100,
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

    let transfer_amount = 69 * ONE_SOL_IN_LAMPORTS;

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // Fee accounts — wrong beneficiary
                AccountMeta::new_readonly(fee_program_id(), false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(wrong_fee_beneficiary, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    // With sentinel-based fee beneficiary detection, a wrong beneficiary means the
    // sentinel is never found and accounts are exhausted → NotEnoughAccountKeys.
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::NotEnoughAccountKeys),
    );
}

#[tokio::test]
async fn test_transfer_remote_fee_after_beneficiary_change() {
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

    // Beneficiary A
    let beneficiary_a = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &beneficiary_a,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;
    let beneficiary_a_balance_before = banks_client.get_balance(beneficiary_a).await.unwrap();

    let salt = H256::zero();
    let max_fee: u64 = 200_000_000; // 0.2 SOL
    let half_amount: u64 = 50 * ONE_SOL_IN_LAMPORTS;
    let fee_data = FeeData::Linear {
        max_fee,
        half_amount,
    };
    let fee_key = init_fee_account(&mut banks_client, &payer, salt, beneficiary_a, fee_data).await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

    let token_sender =
        new_funded_keypair(&mut banks_client, &payer, 200 * ONE_SOL_IN_LAMPORTS).await;
    let token_sender_pubkey = token_sender.pubkey();

    let transfer_amount = 69 * ONE_SOL_IN_LAMPORTS;
    let expected_fee: u64 = {
        let a = transfer_amount as u128;
        let m = max_fee as u128;
        let h = half_amount as u128;
        std::cmp::min(max_fee as u128, (a * m) / (2 * h)) as u64
    };

    // First transfer → fees go to beneficiary A
    {
        let unique_msg = Keypair::new();
        let (dispatched_msg_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
            &mailbox_program_id,
        );
        let (gas_payment_key, _) = Pubkey::find_program_address(
            igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
            &igp_program_id(),
        );

        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
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
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_key, false),
                    AccountMeta::new(beneficiary_a, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            recent_blockhash,
        );
        banks_client.process_transaction(transaction).await.unwrap();
    }

    // Verify fees went to beneficiary A
    assert_lamports(
        &mut banks_client,
        &beneficiary_a,
        beneficiary_a_balance_before + expected_fee,
    )
    .await;

    // Change beneficiary from A → B
    let beneficiary_b = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &beneficiary_b,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;
    let beneficiary_b_balance_before = banks_client.get_balance(beneficiary_b).await.unwrap();

    let set_ben_ixn = hyperlane_sealevel_fee::instruction::set_beneficiary_instruction(
        fee_program_id(),
        payer.pubkey(),
        fee_key,
        beneficiary_b,
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, set_ben_ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Second transfer → fees should go to beneficiary B
    {
        let unique_msg = Keypair::new();
        let (dispatched_msg_key, _) = Pubkey::find_program_address(
            mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
            &mailbox_program_id,
        );
        let (gas_payment_key, _) = Pubkey::find_program_address(
            igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
            &igp_program_id(),
        );

        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        let transaction = Transaction::new_signed_with_payer(
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
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    AccountMeta::new_readonly(fee_program_id(), false),
                    AccountMeta::new_readonly(fee_key, false),
                    AccountMeta::new(beneficiary_b, false),
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            recent_blockhash,
        );
        banks_client.process_transaction(transaction).await.unwrap();
    }

    // Verify beneficiary A balance unchanged (no new fees)
    assert_lamports(
        &mut banks_client,
        &beneficiary_a,
        beneficiary_a_balance_before + expected_fee,
    )
    .await;

    // Verify beneficiary B got fees from second transfer
    assert_lamports(
        &mut banks_client,
        &beneficiary_b,
        beneficiary_b_balance_before + expected_fee,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_remote_with_routing_fee() {
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

    // Init a Routing fee account (no inline fee data — routes are per-domain)
    let fee_beneficiary_wallet = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary_wallet,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;
    let fee_beneficiary_balance_before = banks_client
        .get_balance(fee_beneficiary_wallet)
        .await
        .unwrap();

    let routing_fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        fee_beneficiary_wallet,
        FeeData::Routing,
    )
    .await;

    // Set a route for REMOTE_DOMAIN with Linear fee params
    let max_fee: u64 = 200_000_000;
    let half_amount: u64 = 50 * ONE_SOL_IN_LAMPORTS;
    let set_route_ixn = set_route_instruction(
        fee_program_id(),
        payer.pubkey(),
        routing_fee_key,
        REMOTE_DOMAIN,
        FeeData::Linear {
            max_fee,
            half_amount,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, set_route_ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Derive the route PDA
    let (route_pda, _) = Pubkey::find_program_address(
        fee_route_pda_seeds!(routing_fee_key, REMOTE_DOMAIN),
        &fee_program_id(),
    );

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: routing_fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

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

    let transfer_amount = 69 * ONE_SOL_IN_LAMPORTS;
    let expected_fee: u64 = {
        let a = transfer_amount as u128;
        let m = max_fee as u128;
        let h = half_amount as u128;
        std::cmp::min(max_fee as u128, (a * m) / (2 * h)) as u64
    };

    let native_collateral_before = banks_client
        .get_balance(hyperlane_token_accounts.native_collateral)
        .await
        .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                // 0-8: standard accounts
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // Fee accounts (Routing: route_pda is additional account before sentinel)
                AccountMeta::new_readonly(fee_program_id(), false),
                AccountMeta::new_readonly(routing_fee_key, false),
                AccountMeta::new_readonly(route_pda, false),
                AccountMeta::new(fee_beneficiary_wallet, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts (native): system_program, native_collateral
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify native collateral received transfer_amount
    assert_lamports(
        &mut banks_client,
        &hyperlane_token_accounts.native_collateral,
        native_collateral_before + transfer_amount,
    )
    .await;

    // Verify fee beneficiary received fee lamports
    assert_lamports(
        &mut banks_client,
        &fee_beneficiary_wallet,
        fee_beneficiary_balance_before + expected_fee,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_remote_errors_if_fee_program_mismatch() {
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

    let fee_data = FeeData::Linear {
        max_fee: 200_000_000,
        half_amount: 50 * ONE_SOL_IN_LAMPORTS,
    };
    let fee_beneficiary_wallet = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary_wallet,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;

    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        fee_beneficiary_wallet,
        fee_data,
    )
    .await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

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

    let transfer_amount = 10 * ONE_SOL_IN_LAMPORTS;

    // Pass WRONG fee program in accounts
    let wrong_fee_program = Pubkey::new_unique();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // WRONG fee program
                AccountMeta::new_readonly(wrong_fee_program, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(fee_beneficiary_wallet, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts (native)
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(6)),
    );
}

#[tokio::test]
async fn test_transfer_remote_errors_if_fee_account_mismatch() {
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

    let fee_data = FeeData::Linear {
        max_fee: 200_000_000,
        half_amount: 50 * ONE_SOL_IN_LAMPORTS,
    };
    let fee_beneficiary_wallet = Pubkey::new_unique();
    transfer_lamports(
        &mut banks_client,
        &payer,
        &fee_beneficiary_wallet,
        ONE_SOL_IN_LAMPORTS / 100,
    )
    .await;

    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        fee_beneficiary_wallet,
        fee_data,
    )
    .await;

    let fee_config = FeeConfig {
        fee_program: fee_program_id(),
        fee_account: fee_key,
    };
    set_fee_config(&mut banks_client, &program_id, &payer, Some(fee_config)).await;

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

    let transfer_amount = 10 * ONE_SOL_IN_LAMPORTS;

    // Pass correct fee program but WRONG fee account
    let wrong_fee_account = Pubkey::new_unique();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                AccountMeta::new_readonly(token_sender_pubkey, true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_key, false),
                // Correct fee program, WRONG fee account
                AccountMeta::new_readonly(fee_program_id(), false),
                AccountMeta::new_readonly(wrong_fee_account, false),
                AccountMeta::new(fee_beneficiary_wallet, false),
                // IGP accounts
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin accounts (native)
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(hyperlane_token_accounts.native_collateral, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(7)),
    );
}
