//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use account_utils::DiscriminatorEncode;
use hyperlane_core::{Decode, Encode, HyperlaneMessage, H160, H256, U256};
use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_fee::{
    accounts::{FeeData, LeafFeeConfig, WILDCARD_DOMAIN},
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    fee_standing_quote_pda_seeds, instruction as fee_instruction,
    processor::process_instruction as fee_process_instruction,
};
use hyperlane_sealevel_igp::{
    accounts::{
        GasPaymentAccount, GasPaymentData, IgpFeeConfig, InterchainGasPaymasterType,
        WILDCARD_DOMAIN as IGP_WILDCARD_DOMAIN, WILDCARD_SENDER,
    },
    igp_gas_payment_pda_seeds, igp_standing_quote_pda_seeds,
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
use hyperlane_sealevel_token::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_mint_pda_seeds, plugin::SyntheticPlugin,
    processor::process_instruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{convert_decimals, FeeConfig, HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction, TransferRemote},
};
use hyperlane_test_utils::{
    assert_token_balance, assert_transaction_error, igp_program_id, initialize_igp_accounts,
    initialize_mailbox, mailbox_id, new_funded_keypair, process, transfer_lamports, IgpAccounts,
    MailboxAccounts,
};
use hyperlane_warp_route::TokenMessage;
use k256::ecdsa::{SigningKey, VerifyingKey};
use quote_verifier::SvmSignedQuote;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use solana_system_interface::program as system_program;
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::extension::metadata_pointer::instruction as metadata_pointer_instruction;
use spl_token_2022::instruction::initialize_mint2;
use std::collections::HashMap;

/// There are 1e9 lamports in one SOL.
const ONE_SOL_IN_LAMPORTS: u64 = 1000000000;
const LOCAL_DOMAIN: u32 = 1234;
const LOCAL_DECIMALS: u8 = 8;
const LOCAL_DECIMALS_U32: u32 = LOCAL_DECIMALS as u32;
const REMOTE_DOMAIN: u32 = 4321;
const REMOTE_DECIMALS: u8 = 18;
const REMOTE_GAS_AMOUNT: u64 = 200000;

fn hyperlane_sealevel_token_id() -> Pubkey {
    pubkey!("3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = hyperlane_sealevel_token_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token",
        program_id,
        processor!(process_instruction),
    );

    // Use the bundled BPF programs for SPL Token 2022 and ATA instead of processor!-based ones.
    // The processor!-based approach doesn't work because spl-token-2022 v10 and spl-associated-token-account v8
    // use solana_cpi::invoke which bypasses ProgramTest's syscall stubs.
    // The bundled BPF programs (spl_token_2022-8.0.0.so, spl_associated_token_account-1.1.1.so)
    // are actual compiled programs that use proper syscalls.
    // Note: We don't call add_program for these - ProgramTest automatically loads them.

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

struct HyperlaneTokenAccounts {
    token: Pubkey,
    token_bump: u8,
    mailbox_process_authority: Pubkey,
    dispatch_authority: Pubkey,
    dispatch_authority_bump: u8,
    mint: Pubkey,
    mint_bump: u8,
    ata_payer: Pubkey,
    ata_payer_bump: u8,
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

    let (mint_account_key, mint_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), program_id);

    let (ata_payer_account_key, ata_payer_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), program_id);

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[
            Instruction::new_with_bytes(
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
                    // 4. `[writable]` The mint / mint authority PDA account.
                    // 5. `[writable]` The ATA payer PDA account.
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new(token_account_key, false),
                    AccountMeta::new(dispatch_authority_key, false),
                    AccountMeta::new_readonly(payer.pubkey(), true),
                    AccountMeta::new(mint_account_key, false),
                    AccountMeta::new(ata_payer_account_key, false),
                ],
            ),
            // Initialize MetadataPointer extension before InitializeMint2
            // Required because MINT_ACCOUNT_SIZE (234) was calculated for MetadataPointer
            metadata_pointer_instruction::initialize(
                &spl_token_2022::id(),
                &mint_account_key,
                Some(mint_account_key), // authority
                Some(mint_account_key), // metadata_address (points to self)
            )
            .unwrap(),
            initialize_mint2(
                &spl_token_2022::id(),
                &mint_account_key,
                &mint_account_key,
                None,
                LOCAL_DECIMALS,
            )
            .unwrap(),
        ],
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
        mint: mint_account_key,
        mint_bump: mint_account_bump_seed,
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
    let program_id = hyperlane_sealevel_token_id();
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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
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
            plugin_data: SyntheticPlugin {
                mint: hyperlane_token_accounts.mint,
                mint_bump: hyperlane_token_accounts.mint_bump,
                ata_payer_bump: hyperlane_token_accounts.ata_payer_bump,
            },
            fee_config: None,
        }),
    );

    // Verify the mint account was created.
    let mint_account = banks_client
        .get_account(hyperlane_token_accounts.mint)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mint_account.owner, spl_token_2022::id());
    assert!(!mint_account.data.is_empty());

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
    let program_id = hyperlane_sealevel_token_id();

    let (mut banks_client, payer) = setup_client().await;

    initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
        .await
        .unwrap();

    let new_payer = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // To ensure a different signature is used, we'll use a different payer
    let init_result =
        initialize_hyperlane_token(&program_id, &mut banks_client, &new_payer, None).await;

    assert_transaction_error(
        init_result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

async fn transfer_from_remote(
    remote_transfer_amount: U256,
    sender_override: Option<H256>,
    origin_override: Option<u32>,
    recipient_wallet: Option<Pubkey>,
) -> Result<
    (
        BanksClient,
        Keypair,
        MailboxAccounts,
        IgpAccounts,
        HyperlaneTokenAccounts,
        Pubkey,
    ),
    BanksClientError,
> {
    let program_id = hyperlane_sealevel_token_id();
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

    let recipient_pubkey = recipient_wallet.unwrap_or_else(Pubkey::new_unique);
    let recipient: H256 = recipient_pubkey.to_bytes().into();

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_pubkey,
            &hyperlane_token_accounts.mint,
            &spl_token_2022::id(),
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
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        recipient_associated_token_account,
    ))
}

// Tests when the SPL token is the 2022 version
#[tokio::test]
async fn test_transfer_from_remote() {
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    let (
        mut banks_client,
        _payer,
        _mailbox_accounts,
        _igp_accounts,
        _hyperlane_token_accounts,
        recipient_associated_token_account,
    ) = transfer_from_remote(remote_transfer_amount, None, None, None)
        .await
        .unwrap();

    // Check that the recipient's ATA got the tokens!
    assert_token_balance(
        &mut banks_client,
        &recipient_associated_token_account,
        local_transfer_amount,
    )
    .await;
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_sender_not_router() {
    let local_transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let remote_transfer_amount = convert_decimals(
        local_transfer_amount.into(),
        LOCAL_DECIMALS,
        REMOTE_DECIMALS,
    )
    .unwrap();

    // Same remote domain origin, but wrong sender.
    let result =
        transfer_from_remote(remote_transfer_amount, Some(H256::random()), None, None).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );

    // Wrong remote domain origin, but correct sender.
    let result =
        transfer_from_remote(remote_transfer_amount, None, Some(REMOTE_DOMAIN + 1), None).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
    );
}

#[tokio::test]
async fn test_transfer_from_remote_errors_if_process_authority_not_signer() {
    let program_id = hyperlane_sealevel_token_id();
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

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_pubkey,
            &hyperlane_token_accounts.mint,
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
                // 0. `[signer]` Mailbox process authority specific to this program.
                // 1. `[executable]` system_program
                // 2. `[]` hyperlane_token storage
                // 3. `[]` recipient wallet address
                // 4. `[executable]` SPL token 2022 program
                // 5. `[executable]` SPL associated token account
                // 6. `[writeable]` Mint account
                // 7. `[writeable]` Recipient associated token account
                // 8. `[writeable]` ATA payer PDA account.
                AccountMeta::new_readonly(
                    hyperlane_token_accounts.mailbox_process_authority,
                    false,
                ),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                AccountMeta::new_readonly(recipient_pubkey, false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                AccountMeta::new(hyperlane_token_accounts.mint, false),
                AccountMeta::new(recipient_associated_token_account, false),
                AccountMeta::new(hyperlane_token_accounts.ata_payer, false),
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
async fn test_transfer_remote() {
    let program_id = hyperlane_sealevel_token_id();
    let mailbox_program_id = mailbox_id();

    let token_sender = Keypair::new();
    let token_sender_pubkey = token_sender.pubkey();

    // Mint 100 tokens to the token sender's ATA.
    // We do this by just faking a transfer from remote.
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let (
        mut banks_client,
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        token_sender_ata,
    ) = transfer_from_remote(
        // The amount of remote tokens is expected
        convert_decimals(
            sender_initial_balance.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap(),
        None,
        None,
        Some(token_sender_pubkey),
    )
    .await
    .unwrap();

    // Give the token_sender a SOL balance to pay tx fees.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &token_sender_pubkey,
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
            // 15. `[writeable]` The mint / mint authority PDA account.
            // 16. `[writeable]` The token sender's associated token account, from which tokens will be burned.
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
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new(hyperlane_token_accounts.mint, false),
                AccountMeta::new(token_sender_ata, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify the token sender's ATA balance went down
    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        sender_initial_balance - transfer_amount,
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

#[tokio::test]
async fn test_enroll_remote_router() {
    let program_id = hyperlane_sealevel_token_id();

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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        token.remote_routers,
        vec![(REMOTE_DOMAIN, remote_router)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_enroll_remote_router_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Use the non_owner as the payer, which has a balance but is not the owner,
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

    // Also try using the non_owner as the payer and specifying the correct
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
    let program_id = hyperlane_sealevel_token_id();

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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        token.destination_gas,
        vec![(REMOTE_DOMAIN, gas)].into_iter().collect(),
    );
}

#[tokio::test]
async fn test_set_destination_gas_configs_errors_if_not_signed_by_owner() {
    let program_id = hyperlane_sealevel_token_id();

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
    let program_id = hyperlane_sealevel_token_id();

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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.owner, new_owner);
}

#[tokio::test]
async fn test_transfer_ownership_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_id();

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
    let program_id = hyperlane_sealevel_token_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let new_ism = Some(Pubkey::new_unique());

    // Set the ISM
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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_security_module, new_ism);
}

#[tokio::test]
async fn test_set_interchain_security_module_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_id();

    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

    let new_ism = Some(Pubkey::new_unique());
    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

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
    let program_id = hyperlane_sealevel_token_id();

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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &token_account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.interchain_gas_paymaster, new_igp);
}

#[tokio::test]
async fn test_set_interchain_gas_paymaster_errors_if_owner_not_signer() {
    let program_id = hyperlane_sealevel_token_id();

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

const FEE_MAX: u64 = 100; // 100 local-decimal units max fee
const FEE_HALF_AMOUNT: u64 = 500_000; // half_amount in local decimals

#[tokio::test]
async fn test_transfer_remote_with_fee_synthetic() {
    let program_id = hyperlane_sealevel_token_id();
    let mailbox_program_id = mailbox_id();

    let token_sender = Keypair::new();
    let token_sender_pubkey = token_sender.pubkey();

    // Mint tokens to sender via fake transfer_from_remote.
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let (
        mut banks_client,
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        token_sender_ata,
    ) = transfer_from_remote(
        convert_decimals(
            sender_initial_balance.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap(),
        None,
        None,
        Some(token_sender_pubkey),
    )
    .await
    .unwrap();

    // Give the token_sender SOL for tx fees.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &token_sender_pubkey,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

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

    // Initialize a Leaf fee account.
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
            payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
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
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // The fee beneficiary for synthetic is an ATA: (beneficiary_owner, mint, spl_token_2022).
    let fee_beneficiary_ata = get_associated_token_address_with_program_id(
        &fee_beneficiary_owner,
        &hyperlane_token_accounts.mint,
        &spl_token_2022::id(),
    );

    // Pre-create the beneficiary ATA. The ATA payer PDA needs funds.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

    // Create ATA via a fake transfer_from_remote to the beneficiary_owner.
    // Simpler: just create the ATA directly using the SPL ATA instruction.
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &payer.pubkey(),
                    &fee_beneficiary_owner,
                    &hyperlane_token_accounts.mint,
                    &spl_token_2022::id(),
                ),
            ],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

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
    // Transfer 69 tokens. With Linear(max_fee=100, half_amount=500_000) and
    // amount = 69 * 10^8 = 6_900_000_000:
    // fee = min(100, 6_900_000_000 * 100 / 1_000_000) = min(100, 690_000) = 100
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = FEE_MAX;

    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

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
                    AccountMeta::new(fee_beneficiary_ata, false), // terminal
                    // IGP
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin (synthetic: spl_token_2022 + mint + sender_ata)
                    AccountMeta::new_readonly(spl_token_2022::id(), false),
                    AccountMeta::new(hyperlane_token_accounts.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_message_account_keypair],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Verify sender balance: initial - transfer_amount - fee.
    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        sender_initial_balance - transfer_amount - expected_fee,
    )
    .await;

    // Verify beneficiary ATA received the exact fee.
    assert_token_balance(&mut banks_client, &fee_beneficiary_ata, expected_fee).await;

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
async fn test_transfer_remote_with_fee_routing_mode() {
    use hyperlane_sealevel_fee::accounts::RoutingFeeConfig;

    let program_id = hyperlane_sealevel_token_id();
    let mailbox_program_id = mailbox_id();
    let token_sender = Keypair::new();
    let token_sender_pubkey = token_sender.pubkey();

    // Mint tokens to sender via transfer_from_remote.
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let (
        mut banks_client,
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        token_sender_ata,
    ) = transfer_from_remote(
        convert_decimals(
            sender_initial_balance.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap(),
        None,
        None,
        Some(token_sender_pubkey),
    )
    .await
    .unwrap();

    transfer_lamports(
        &mut banks_client,
        &payer,
        &token_sender_pubkey,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

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

    // Init Routing-mode fee account + set route.
    let fee_beneficiary_owner = Pubkey::new_unique();
    let fee_salt = H256::zero();
    let fp = fee_program_id();
    let (fee_account_key, _) = Pubkey::find_program_address(fee_account_pda_seeds!(fee_salt), &fp);

    let route_max_fee: u64 = 50;
    let route_half_amount: u64 = 500_000;

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                fee_instruction::init_fee_instruction(
                    fp,
                    payer.pubkey(),
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
                    payer.pubkey(),
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
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Create beneficiary ATA.
    let fee_beneficiary_ata = get_associated_token_address_with_program_id(
        &fee_beneficiary_owner,
        &hyperlane_token_accounts.mint,
        &spl_token_2022::id(),
    );
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &payer.pubkey(),
                    &fee_beneficiary_owner,
                    &hyperlane_token_accounts.mint,
                    &spl_token_2022::id(),
                ),
            ],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    // Derive PDAs.
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

    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let expected_fee = route_max_fee; // amount >> half_amount → capped

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_program_id,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
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
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.token, false),
                    AccountMeta::new_readonly(mailbox_accounts.program, false),
                    AccountMeta::new(mailbox_accounts.outbox, false),
                    AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                    AccountMeta::new_readonly(token_sender_pubkey, true),
                    AccountMeta::new_readonly(unique_msg.pubkey(), true),
                    AccountMeta::new(dispatched_msg_key, false),
                    // Fee (Routing: standing + route PDA)
                    AccountMeta::new_readonly(fp, false),
                    AccountMeta::new_readonly(fee_account_key, false),
                    AccountMeta::new_readonly(domain_standing_quote_pda, false),
                    AccountMeta::new_readonly(wildcard_standing_quote_pda, false),
                    AccountMeta::new_readonly(route_pda, false),
                    AccountMeta::new(fee_beneficiary_ata, false),
                    // IGP
                    AccountMeta::new_readonly(igp_accounts.program, false),
                    AccountMeta::new(igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                    AccountMeta::new(igp_accounts.igp, false),
                    // Plugin
                    AccountMeta::new_readonly(spl_token_2022::id(), false),
                    AccountMeta::new(hyperlane_token_accounts.mint, false),
                    AccountMeta::new(token_sender_ata, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&token_sender, &unique_msg],
            recent_blockhash,
        ))
        .await
        .unwrap();

    assert_token_balance(
        &mut banks_client,
        &token_sender_ata,
        sender_initial_balance - transfer_amount - expected_fee,
    )
    .await;
    assert_token_balance(&mut banks_client, &fee_beneficiary_ata, expected_fee).await;
}

// === Additional fee tests for parity with native ===

#[tokio::test]
async fn test_set_fee_config() {
    let program_id = hyperlane_sealevel_token_id();
    let (mut banks_client, payer) = setup_client().await;

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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &account_data[..])
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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &account_data[..])
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
    let token = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(token.fee_config, None);
}

#[tokio::test]
async fn test_set_fee_config_non_owner_fails() {
    let program_id = hyperlane_sealevel_token_id();
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
async fn test_get_program_version() {
    use package_versioned::{get_program_version_instruction_data, PACKAGE_VERSION};
    use serializable_account_meta::SimulationReturnData;
    use solana_sdk::message::Message;

    let program_id = hyperlane_sealevel_token_id();
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
    let program_id = hyperlane_sealevel_token_id();
    let (mut banks_client, payer) = setup_client().await;

    let hyperlane_token_accounts =
        initialize_hyperlane_token(&program_id, &mut banks_client, &payer, None)
            .await
            .unwrap();

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

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

/// Shared setup for synthetic negative fee tests.
struct SyntheticFeeTestContext {
    banks_client: BanksClient,
    program_id: Pubkey,
    mailbox_accounts: MailboxAccounts,
    igp_accounts: IgpAccounts,
    hyperlane_token_accounts: HyperlaneTokenAccounts,
    token_sender: Keypair,
    token_sender_ata: Pubkey,
    fee_account_key: Pubkey,
    fee_beneficiary_ata: Pubkey,
    domain_standing_quote_pda: Pubkey,
    wildcard_standing_quote_pda: Pubkey,
}

async fn setup_synthetic_fee_test_context() -> SyntheticFeeTestContext {
    let program_id = hyperlane_sealevel_token_id();

    let token_sender = Keypair::new();
    let token_sender_pubkey = token_sender.pubkey();

    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let (
        mut banks_client,
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        token_sender_ata,
    ) = transfer_from_remote(
        convert_decimals(
            sender_initial_balance.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap(),
        None,
        None,
        Some(token_sender_pubkey),
    )
    .await
    .unwrap();

    transfer_lamports(
        &mut banks_client,
        &payer,
        &token_sender_pubkey,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

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
            payer.pubkey(),
            fee_salt,
            fee_beneficiary_owner,
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
                ],
            )],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

    let fee_beneficiary_ata = get_associated_token_address_with_program_id(
        &fee_beneficiary_owner,
        &hyperlane_token_accounts.mint,
        &spl_token_2022::id(),
    );

    // Pre-create the beneficiary ATA.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &hyperlane_token_accounts.ata_payer,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &[
                spl_associated_token_account::instruction::create_associated_token_account(
                    &payer.pubkey(),
                    &fee_beneficiary_owner,
                    &hyperlane_token_accounts.mint,
                    &spl_token_2022::id(),
                ),
            ],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        ))
        .await
        .unwrap();

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

    SyntheticFeeTestContext {
        banks_client,
        program_id,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
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
    let ctx = setup_synthetic_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);
    let wrong_fee_program = Pubkey::new_unique();

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_msg.pubkey()),
        &igp_program_id(),
    );

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
                    AccountMeta::new(ctx.fee_beneficiary_ata, false),
                    // IGP
                    AccountMeta::new_readonly(ctx.igp_accounts.program, false),
                    AccountMeta::new(ctx.igp_accounts.program_data, false),
                    AccountMeta::new(gas_payment_pda_key, false),
                    AccountMeta::new_readonly(ctx.igp_accounts.overhead_igp, false),
                    AccountMeta::new(ctx.igp_accounts.igp, false),
                    // Plugin
                    AccountMeta::new_readonly(spl_token_2022::id(), false),
                    AccountMeta::new(ctx.hyperlane_token_accounts.mint, false),
                    AccountMeta::new(ctx.token_sender_ata, false),
                ],
            )],
            Some(&token_sender_pubkey),
            &[&ctx.token_sender, &unique_msg],
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
    let ctx = setup_synthetic_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );

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
    let ctx = setup_synthetic_fee_test_context().await;
    let token_sender_pubkey = ctx.token_sender.pubkey();
    let transfer_amount = 69 * 10u64.pow(LOCAL_DECIMALS_U32);

    let unique_msg = Keypair::new();
    let (dispatched_msg_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_msg.pubkey()),
        &mailbox_id(),
    );

    let mut accounts = vec![
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

// ========================================================================
// IGP new flow (custom quote) helpers
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
    let (pda, _) = Pubkey::find_program_address(
        igp_standing_quote_pda_seeds!(igp_key, fee_token_mint, &dest_le, sender),
        &igp_program_id(),
    );
    pda
}

/// Enables IGP quoting and adds a signer. Returns (signing_key, signer_address).
async fn setup_igp_new_flow(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp_key: &Pubkey,
) -> SigningKey {
    // Enable quoting on the IGP.
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

    // Add a signer.
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
        now + 3600, // expires in 1 hour
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
// IGP new flow tests
// ========================================================================

#[tokio::test]
async fn test_transfer_remote_igp_new_flow_standing_exact() {
    let program_id = hyperlane_sealevel_token_id();

    let token_sender = Keypair::new();
    let token_sender_pubkey = token_sender.pubkey();

    // Mint tokens via fake transfer_from_remote.
    let sender_initial_balance = 100 * 10u64.pow(LOCAL_DECIMALS_U32);
    let (
        mut banks_client,
        payer,
        mailbox_accounts,
        igp_accounts,
        hyperlane_token_accounts,
        token_sender_ata,
    ) = transfer_from_remote(
        convert_decimals(
            sender_initial_balance.into(),
            LOCAL_DECIMALS,
            REMOTE_DECIMALS,
        )
        .unwrap(),
        None,
        None,
        Some(token_sender_pubkey),
    )
    .await
    .unwrap();

    // Fund the sender.
    transfer_lamports(
        &mut banks_client,
        &payer,
        &token_sender_pubkey,
        ONE_SOL_IN_LAMPORTS,
    )
    .await;

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

    // Enable IGP quoting and submit a standing quote with custom pricing.
    // Use exchange_rate=2*SCALE and gas_price=5 so the payment is
    // distinguishable from the oracle (which uses rate=SCALE, price=1).
    let signing_key = setup_igp_new_flow(&mut banks_client, &payer, &igp_accounts.igp).await;

    let quote_exchange_rate = 2 * hyperlane_sealevel_igp::accounts::TOKEN_EXCHANGE_RATE_SCALE;
    let quote_gas_price: u128 = 5;
    let quote_token_decimals: u8 = 9; // SOL

    submit_standing_igp_quote(
        &mut banks_client,
        &payer,
        &igp_accounts.igp,
        &signing_key,
        REMOTE_DOMAIN,
        &program_id, // sender = warp route program
        quote_exchange_rate,
        quote_gas_price,
        quote_token_decimals,
    )
    .await;

    // Build transfer_remote with new flow account layout.
    let unique_message_account_keypair = Keypair::new();
    let (dispatched_message_key, _) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_accounts.program,
    );
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &igp_program_id(),
    );

    let exact_standing_pda = derive_igp_standing_quote_pda(
        &igp_accounts.igp,
        &Pubkey::default(),
        REMOTE_DOMAIN,
        &program_id,
    );

    let transfer_amount = 10 * 10u64.pow(LOCAL_DECIMALS_U32);

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
                // IGP new flow: igp_program, program_data, payment_pda,
                //   sender_authority, quoted_sender, [variable], terminal, [inner_igp]
                AccountMeta::new_readonly(igp_accounts.program, false),
                AccountMeta::new(igp_accounts.program_data, false),
                AccountMeta::new(gas_payment_pda_key, false),
                // sender_authority = dispatch_authority
                AccountMeta::new_readonly(hyperlane_token_accounts.dispatch_authority, false),
                // quoted_sender = program_id
                AccountMeta::new_readonly(program_id, false),
                // variable: exact standing quote PDA
                AccountMeta::new_readonly(exact_standing_pda, false),
                // TERMINAL: configured_igp (OverheadIgp)
                AccountMeta::new_readonly(igp_accounts.overhead_igp, false),
                // inner_igp (after terminal for OverheadIgp)
                AccountMeta::new(igp_accounts.igp, false),
                // Plugin (synthetic)
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new(hyperlane_token_accounts.mint, false),
                AccountMeta::new(token_sender_ata, false),
            ],
        )],
        Some(&token_sender_pubkey),
        &[&token_sender, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await.unwrap();

    // Verify gas payment uses quote pricing, not oracle.
    //
    // compute_gas_fee formula:
    //   dest_cost = gas_amount * gas_price
    //   origin_cost = dest_cost * exchange_rate / SCALE
    //   fee = convert_decimals(origin_cost, token_decimals, SOL_DECIMALS=9)
    //
    // With quote: gas_amount=200000, gas_price=5, exchange_rate=2*SCALE, decimals=9:
    //   dest_cost = 200000 * 5 = 1_000_000
    //   origin_cost = 1_000_000 * 2 = 2_000_000
    //   fee = convert_decimals(2_000_000, 9, 9) = 2_000_000 lamports
    //
    // With oracle: gas_amount=200000, gas_price=1, exchange_rate=SCALE, decimals=9:
    //   dest_cost = 200000 * 1 = 200_000
    //   origin_cost = 200_000 * 1 = 200_000
    //   fee = 200_000 lamports
    //
    // Note: initialize_igp_accounts sets gas_overhead=None, so overhead=0.
    let scale = hyperlane_sealevel_igp::accounts::TOKEN_EXCHANGE_RATE_SCALE;
    let expected_gas_amount = REMOTE_GAS_AMOUNT; // no overhead configured
    let dest_cost = (expected_gas_amount as u128) * quote_gas_price;
    let origin_cost = dest_cost * quote_exchange_rate / scale;
    let expected_payment = origin_cost as u64; // decimals match (9→9), no conversion

    // Sanity: quote payment differs from oracle payment.
    let oracle_payment = REMOTE_GAS_AMOUNT; // oracle: gas_amount * 1 * SCALE / SCALE = gas_amount
    assert_ne!(
        expected_payment, oracle_payment,
        "quote payment should differ from oracle payment"
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

    let transfer_remote_tx_status = banks_client
        .get_transaction_status(tx_signature)
        .await
        .unwrap()
        .unwrap();

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
    let message =
        HyperlaneMessage::read_from(&mut &dispatched_message.encoded_message[..]).unwrap();

    assert_eq!(
        *gas_payment,
        GasPaymentData {
            sequence_number: 0,
            igp: igp_accounts.igp,
            destination_domain: REMOTE_DOMAIN,
            message_id: message.id(),
            gas_amount: expected_gas_amount,
            unique_gas_payment_pubkey: unique_message_account_keypair.pubkey(),
            slot: transfer_remote_tx_status.slot,
            payment: expected_payment,
        }
        .into(),
    );
}
