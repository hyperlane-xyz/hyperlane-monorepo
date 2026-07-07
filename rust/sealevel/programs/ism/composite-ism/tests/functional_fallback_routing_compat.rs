//! Functional tests for FallbackRouting with backwards-compatible external ISMs
//! and with another composite ISM as the fallback.
//!
//! Three paths in `metadata_spec.rs` are exercised:
//!
//! 1. **test-ism** (`ModuleType::Unused`): returns `MetadataSpec::Null` directly.
//!
//! 2. **multisig-ism-message-id** (`ModuleType::MessageIdMultisig`): CPIs to
//!    `MultisigIsmInstruction::ValidatorsAndThreshold` with the domain data PDA.
//!
//! 3. **composite ISM** (any other `ModuleType`): CPIs to the fallback ISM's
//!    `VerifyMetadataSpec` and propagates the result.
//!
//! All paths are tested for:
//! - VerifyAccountMetas fixpoint convergence.
//! - VerifyMetadataSpec fixpoint convergence.
//! - Verify (accept/reject).
//!
//! An end-to-end mailbox test with test-ism as fallback verifies the full
//! process path.

mod common;

use borsh::BorshDeserialize;
use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, HyperlaneMessage, H160, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::IsmNode, instruction::initialize_instruction as composite_initialize_instruction,
    processor::process_instruction as composite_process_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpec, MetadataSpecResult, VerifyInstruction,
    VerifyMetadataSpecInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_multisig_ism_message_id::instruction::{
    init_instruction as multisig_init_instruction, set_validators_and_threshold_instruction,
    ValidatorsAndThreshold as MultisigValidatorsAndThreshold,
};
use hyperlane_sealevel_test_send_receiver::program::IsmReturnDataMode;
use hyperlane_test_utils::{
    get_handle_account_metas, get_ism_getter_account_metas, get_recipient_ism_with_account_metas,
    initialize_mailbox, mailbox_id, process_with_accounts,
};
use multisig_ism::{domain_data_pda, MultisigIsmMessageIdMetadata};
use serializable_account_meta::SimulationReturnData;
use solana_program::instruction::AccountMeta;
use solana_program::pubkey::Pubkey;
use solana_program_test::{processor, BanksClient, ProgramTest};
use solana_sdk::{
    hash::Hash, instruction::Instruction, message::Message, signature::Signer,
    signer::keypair::Keypair, transaction::Transaction,
};
use std::str::FromStr;

use account_utils::SPL_NOOP_PROGRAM_ID;
use hyperlane_sealevel_mailbox::{
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};

use common::{
    assert_simulation_ok, composite_ism_id, domain_pda_key, dummy_message,
    get_all_verify_account_metas, initialize, program_test, simulate_verify, storage_pda_key,
};

const ORIGIN: u32 = 1234;

// ── Fixture data (identical to functional_multisig.rs) ───────────────────────

fn test_message() -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 69,
        origin: ORIGIN,
        sender: H256::from_str(
            "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
        )
        .unwrap(),
        destination: 4321,
        recipient: H256::from_str(
            "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
        )
        .unwrap(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }
}

fn test_checkpoint(message: &HyperlaneMessage) -> CheckpointWithMessageId {
    CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: ORIGIN,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: message.nonce + 1,
        },
        message_id: message.id(),
    }
}

fn test_validators() -> Vec<H160> {
    vec![
        H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
        H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
        H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
    ]
}

fn test_signatures() -> Vec<Vec<u8>> {
    vec![
        hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap(),
        hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap(),
        hex::decode("5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b").unwrap(),
    ]
}

// ── Program IDs ──────────────────────────────────────────────────────────────

fn test_ism_id() -> Pubkey {
    hyperlane_sealevel_test_ism::id()
}

fn multisig_ism_id() -> Pubkey {
    Pubkey::new_from_array([3u8; 32])
}

fn test_ism_storage_pda_key() -> Pubkey {
    Pubkey::find_program_address(&[b"test_ism", b"-", b"storage"], &test_ism_id()).0
}

fn multisig_vam_pda_key() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &multisig_ism_id()).0
}

fn multisig_domain_pda_key() -> Pubkey {
    domain_data_pda(&multisig_ism_id(), ORIGIN).0
}

fn test_ism_vam_pda_key() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &test_ism_id()).0
}

// ── ProgramTest factories ────────────────────────────────────────────────────

fn program_test_with_test_ism() -> ProgramTest {
    let mut test = program_test();
    test.add_program(
        "hyperlane_sealevel_test_ism",
        test_ism_id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );
    test
}

fn program_test_with_multisig() -> ProgramTest {
    let mut test = program_test();
    test.add_program(
        "hyperlane_sealevel_multisig_ism_message_id",
        multisig_ism_id(),
        processor!(hyperlane_sealevel_multisig_ism_message_id::processor::process_instruction),
    );
    test
}

fn program_test_full_mailbox() -> ProgramTest {
    let mut test = program_test();
    test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_id(),
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );
    fn noop(
        _: &Pubkey,
        _: &[solana_program::account_info::AccountInfo],
        _: &[u8],
    ) -> solana_program::entrypoint::ProgramResult {
        Ok(())
    }
    test.add_program("spl_noop", SPL_NOOP_PROGRAM_ID, processor!(noop));
    test.add_program(
        "hyperlane_sealevel_test_ism",
        test_ism_id(),
        processor!(hyperlane_sealevel_test_ism::program::process_instruction),
    );
    test.add_program(
        "hyperlane_sealevel_test_send_receiver",
        hyperlane_sealevel_test_send_receiver::id(),
        processor!(hyperlane_sealevel_test_send_receiver::program::process_instruction),
    );
    test
}

// ── Setup helpers ────────────────────────────────────────────────────────────

/// Initializes the test-ism so its storage PDA exists and accept=true.
async fn init_test_ism(banks_client: &mut BanksClient, payer: &Keypair, blockhash: Hash) {
    use hyperlane_sealevel_test_ism::program::TestIsmInstruction;
    let storage_pda = test_ism_storage_pda_key();
    let ix = Instruction {
        program_id: test_ism_id(),
        data: borsh::to_vec(&TestIsmInstruction::Init).unwrap(),
        accounts: vec![
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(storage_pda, false),
        ],
    };
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], blockhash);
    banks_client.process_transaction(tx).await.unwrap();
}

/// Initializes the multisig-ism-message-id and sets validators for ORIGIN.
async fn init_multisig_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    blockhash: Hash,
    validators: Vec<H160>,
    threshold: u8,
) {
    let init_ix = multisig_init_instruction(multisig_ism_id(), payer.pubkey()).unwrap();
    let tx =
        Transaction::new_signed_with_payer(&[init_ix], Some(&payer.pubkey()), &[payer], blockhash);
    banks_client.process_transaction(tx).await.unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let set_ix = set_validators_and_threshold_instruction(
        multisig_ism_id(),
        payer.pubkey(),
        ORIGIN,
        MultisigValidatorsAndThreshold {
            validators,
            threshold,
        },
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[set_ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

// ── VerifyMetadataSpec fixpoint helpers ──────────────────────────────────────

/// Simulates a single VerifyMetadataSpec call with the given accounts.
async fn call_vms_once(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    message: &HyperlaneMessage,
    accounts: Vec<AccountMeta>,
) -> MetadataSpecResult {
    let ixn_data = InterchainSecurityModuleInstruction::VerifyMetadataSpec(
        VerifyMetadataSpecInstruction::new(message.to_vec()),
    )
    .encode()
    .unwrap();

    let raw = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &ixn_data,
                accounts,
            )],
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

    SimulationReturnData::<MetadataSpecResult>::try_from_slice(&raw)
        .unwrap()
        .return_data
}

/// Runs the VerifyMetadataSpec fixpoint loop until `spec` is Some.
async fn get_all_metadata_spec(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    message: &HyperlaneMessage,
) -> MetadataSpecResult {
    let mut accounts = vec![AccountMeta::new_readonly(storage_pda_key(), false)];
    loop {
        let result = call_vms_once(
            banks_client,
            payer,
            recent_blockhash,
            message,
            accounts.clone(),
        )
        .await;
        if result.spec.is_some() {
            return result;
        }
        accounts = result
            .accounts
            .iter()
            .map(|k| AccountMeta::new_readonly(*k, false))
            .collect();
    }
}

// ── TEST-ISM AS FALLBACK ─────────────────────────────────────────────────────

/// VerifyMetadataSpec converges to Null in 3 passes when the fallback is a
/// test-ism (ModuleType::Unused).
#[tokio::test]
async fn test_vms_test_ism_fallback_returns_null() {
    let mut context = program_test_with_test_ism().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_test_ism(&mut context.banks_client, &payer, bh).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: test_ism_id(),
        },
    )
    .await
    .unwrap();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let mut msg = dummy_message();
    msg.origin = ORIGIN;

    let result = get_all_metadata_spec(&mut context.banks_client, &payer, bh, &msg).await;

    assert_eq!(result.spec, Some(MetadataSpec::Null));
    assert!(result.accounts.is_empty());
}

/// VerifyAccountMetas fixpoint for test-ism as fallback converges to:
/// [storage_pda, domain_pda, test_ism_vam_pda (sentinel), test_ism_storage_pda, test_ism_id]
#[tokio::test]
async fn test_vam_test_ism_fallback_converges() {
    let mut context = program_test_with_test_ism().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_test_ism(&mut context.banks_client, &payer, bh).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: test_ism_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn).await;

    assert_eq!(metas.len(), 5);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, test_ism_vam_pda_key()); // sentinel
    assert_eq!(metas[3].pubkey, test_ism_storage_pda_key()); // from test-ism VAM
    assert_eq!(metas[4].pubkey, test_ism_id());
}

/// Verify with null metadata accepts via the test-ism fallback.
#[tokio::test]
async fn test_verify_test_ism_fallback_accepts() {
    let mut context = program_test_with_test_ism().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_test_ism(&mut context.banks_client, &payer, bh).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: test_ism_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn.clone())
            .await;

    assert_simulation_ok(
        &simulate_verify(&mut context.banks_client, &payer, bh, verify_ixn, metas).await,
    );
}

// ── MULTISIG ISM AS FALLBACK ─────────────────────────────────────────────────

/// VerifyMetadataSpec converges to MultisigMessageId when the fallback is a
/// multisig-ism-message-id. Uses a CPI to MultisigIsmInstruction::ValidatorsAndThreshold
/// rather than reading the domain PDA directly.
#[tokio::test]
async fn test_vms_multisig_fallback_returns_multisig_spec() {
    let validators = test_validators();
    let threshold = 2u8;

    let mut context = program_test_with_multisig().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_multisig_ism(
        &mut context.banks_client,
        &payer,
        bh,
        validators.clone(),
        threshold,
    )
    .await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: multisig_ism_id(),
        },
    )
    .await
    .unwrap();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let mut msg = dummy_message();
    msg.origin = ORIGIN;

    let result = get_all_metadata_spec(&mut context.banks_client, &payer, bh, &msg).await;

    assert_eq!(
        result.spec,
        Some(MetadataSpec::MultisigMessageId {
            validators,
            threshold,
        })
    );
    assert!(result.accounts.is_empty());
}

/// VerifyAccountMetas fixpoint for multisig as fallback converges to:
/// [storage_pda, domain_pda, multisig_vam_pda (sentinel), multisig_domain_pda, multisig_ism_id]
#[tokio::test]
async fn test_vam_multisig_fallback_converges() {
    let mut context = program_test_with_multisig().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_multisig_ism(&mut context.banks_client, &payer, bh, test_validators(), 2).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: multisig_ism_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn).await;

    assert_eq!(metas.len(), 5);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, multisig_vam_pda_key()); // sentinel
    assert_eq!(metas[3].pubkey, multisig_domain_pda_key());
    assert_eq!(metas[4].pubkey, multisig_ism_id());
}

/// Verify with valid ECDSA signatures succeeds via multisig fallback.
#[tokio::test]
async fn test_verify_multisig_fallback_valid_sigs_accepts() {
    let mut context = program_test_with_multisig().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_multisig_ism(&mut context.banks_client, &payer, bh, test_validators(), 2).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: multisig_ism_id(),
        },
    )
    .await
    .unwrap();

    let message = test_message();
    let checkpoint = test_checkpoint(&message);
    let sigs = test_signatures();
    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&sigs[0]).unwrap(),
            EcdsaSignature::from_bytes(&sigs[1]).unwrap(),
        ],
    }
    .to_vec();

    let verify_ixn = VerifyInstruction {
        metadata: metadata.clone(),
        message: message.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn.clone())
            .await;

    assert_simulation_ok(
        &simulate_verify(&mut context.banks_client, &payer, bh, verify_ixn, metas).await,
    );
}

/// Verify with an invalid metadata (too short) is rejected via multisig fallback.
#[tokio::test]
async fn test_verify_multisig_fallback_invalid_metadata_rejects() {
    let mut context = program_test_with_multisig().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    init_multisig_ism(&mut context.banks_client, &payer, bh, test_validators(), 2).await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: multisig_ism_id(),
        },
    )
    .await
    .unwrap();

    let message = test_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![0u8; 10], // too short to parse
        message: message.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn.clone())
            .await;

    // multisig ISM returns InvalidMetadata (custom error 0x7)
    assert!(
        simulate_verify(&mut context.banks_client, &payer, bh, verify_ixn, metas,)
            .await
            .result
            .unwrap()
            .is_err(),
        "expected verify to fail with invalid metadata"
    );
}

// ── MAILBOX INTEGRATION ──────────────────────────────────────────────────────

/// End-to-end: the mailbox processes a message whose recipient's ISM is the
/// composite ISM configured as FallbackRouting → test-ism (Null metadata).
#[tokio::test]
async fn test_mailbox_process_test_ism_fallback() {
    let local_domain = 13775u32;
    let remote_domain = ORIGIN;

    let mut context = program_test_full_mailbox().start_with_context().await;
    let payer = context.payer.insecure_clone();

    // Initialize mailbox (also initializes test-ism as the default ISM).
    let mailbox_accounts = initialize_mailbox(
        &mut context.banks_client,
        &mailbox_id(),
        &payer,
        local_domain,
        0,
        hyperlane_sealevel_mailbox::protocol_fee::ProtocolFee {
            fee: 0,
            beneficiary: payer.pubkey(),
        },
    )
    .await
    .unwrap();

    // Initialize composite ISM with FallbackRouting → test-ism.
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: test_ism_id(),
        },
    )
    .await
    .unwrap();

    // Initialize test-send-receiver and set composite ISM as its ISM.
    let mut receiver =
        hyperlane_sealevel_test_send_receiver::test_client::TestSendReceiverTestClient::new(
            context.banks_client.clone(),
            payer.insecure_clone(),
        );
    receiver.init().await.unwrap();
    receiver
        .set_ism(Some(composite_ism_id()), IsmReturnDataMode::EncodeOption)
        .await
        .unwrap();

    // Build the message targeting the test-send-receiver.
    let recipient = hyperlane_sealevel_test_send_receiver::id();
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: remote_domain,
        sender: H256::zero(),
        destination: local_domain,
        recipient: H256::from(recipient.to_bytes()),
        body: vec![],
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();

    // Get ISM getter account metas (for InterchainSecurityModule instruction).
    let ism_getter_metas =
        get_ism_getter_account_metas(&mut context.banks_client, &payer, recipient)
            .await
            .unwrap();

    // Get the ISM (composite ISM).
    let ism = get_recipient_ism_with_account_metas(
        &mut context.banks_client,
        &payer,
        &mailbox_accounts,
        recipient,
        ism_getter_metas.clone(),
    )
    .await
    .unwrap();
    assert_eq!(ism, composite_ism_id());

    // Get the full fixpoint VAM for the composite ISM (FallbackRouting → test-ism).
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: message.to_vec(),
    };
    let ism_verify_metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn).await;

    // Get handle account metas.
    let handle_metas = get_handle_account_metas(&mut context.banks_client, &payer, &message)
        .await
        .unwrap();

    // Assemble the full process account list.
    let (process_authority_key, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(&recipient),
        &mailbox_accounts.program,
    );
    let (processed_message_pda, _) = Pubkey::find_program_address(
        mailbox_processed_message_pda_seeds!(message.id()),
        &mailbox_accounts.program,
    );

    let mut accounts = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        AccountMeta::new(mailbox_accounts.inbox, false),
        AccountMeta::new_readonly(process_authority_key, false),
        AccountMeta::new(processed_message_pda, false),
    ];
    accounts.extend(ism_getter_metas);
    accounts.extend([
        AccountMeta::new_readonly(SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new_readonly(ism, false),
    ]);
    accounts.extend(ism_verify_metas);
    accounts.extend([AccountMeta::new_readonly(recipient, false)]);
    accounts.extend(handle_metas);

    process_with_accounts(
        &mut context.banks_client,
        &payer,
        &mailbox_accounts,
        vec![],
        &message,
        accounts,
    )
    .await
    .unwrap();
}

// ── COMPOSITE ISM AS FALLBACK ────────────────────────────────────────────────
//
// When the fallback ISM is another composite ISM, `metadata_spec.rs` detects
// `ModuleType::Composite` (not Unused, not MessageIdMultisig) and CPIs to the
// fallback's `VerifyMetadataSpec` instruction.  These tests exercise that path.

fn fallback_composite_ism_id() -> Pubkey {
    Pubkey::new_from_array([2u8; 32])
}

fn fallback_composite_storage_pda_key() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &fallback_composite_ism_id()).0
}

fn program_test_with_composite_fallback() -> ProgramTest {
    let mut test = program_test();
    test.add_program(
        "hyperlane_sealevel_composite_ism",
        fallback_composite_ism_id(),
        processor!(composite_process_instruction),
    );
    test
}

async fn setup_fallback_composite_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    blockhash: Hash,
    root: IsmNode,
) {
    let ix = composite_initialize_instruction(fallback_composite_ism_id(), payer.pubkey(), root)
        .unwrap();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], blockhash);
    banks_client.process_transaction(tx).await.unwrap();
}

/// VMS with composite fallback (MultisigMessageId root) converges in 3 passes via
/// the `VerifyMetadataSpec` CPI path, returning `MetadataSpec::MultisigMessageId`.
#[tokio::test]
async fn test_vms_composite_fallback_multisig_root_returns_multisig_spec() {
    let validators = test_validators();
    let threshold = 2u8;

    let mut context = program_test_with_composite_fallback()
        .start_with_context()
        .await;
    let payer = context.payer.insecure_clone();

    // Initialize fallback composite with MultisigMessageId root.
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_composite_ism(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::MultisigMessageId {
            validators: validators.clone(),
            threshold,
        },
    )
    .await;

    // Initialize outer composite with FallbackRouting → composite2.
    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_composite_ism_id(),
        },
    )
    .await
    .unwrap();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let mut msg = dummy_message();
    msg.origin = ORIGIN;

    let result = get_all_metadata_spec(&mut context.banks_client, &payer, bh, &msg).await;

    assert_eq!(
        result.spec,
        Some(MetadataSpec::MultisigMessageId {
            validators,
            threshold
        })
    );
    assert!(result.accounts.is_empty());
}

/// VMS with composite fallback (Test/Null root) converges in 3 passes via the
/// `VerifyMetadataSpec` CPI path, returning `MetadataSpec::Null`.
#[tokio::test]
async fn test_vms_composite_fallback_null_root_returns_null() {
    let mut context = program_test_with_composite_fallback()
        .start_with_context()
        .await;
    let payer = context.payer.insecure_clone();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_composite_ism(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::Test { accept: true },
    )
    .await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_composite_ism_id(),
        },
    )
    .await
    .unwrap();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let mut msg = dummy_message();
    msg.origin = ORIGIN;

    let result = get_all_metadata_spec(&mut context.banks_client, &payer, bh, &msg).await;

    assert_eq!(result.spec, Some(MetadataSpec::Null));
}

/// VAM with composite fallback (MultisigMessageId root) converges to:
/// [storage_pda, domain_pda, fallback_storage_pda (sentinel/storage), fallback_ism_id]
///
/// The composite fallback's own VAM prepends its storage PDA (= the sentinel), which
/// is deduped by account_metas.rs so it appears exactly once.
#[tokio::test]
async fn test_vam_composite_fallback_converges() {
    let mut context = program_test_with_composite_fallback()
        .start_with_context()
        .await;
    let payer = context.payer.insecure_clone();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_composite_ism(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::MultisigMessageId {
            validators: test_validators(),
            threshold: 2,
        },
    )
    .await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_composite_ism_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn).await;

    // Sentinel (= composite fallback's storage PDA) appears exactly once; duplicate
    // is eliminated by the conditional dedup in account_metas.rs.
    assert_eq!(metas.len(), 4);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_composite_storage_pda_key()); // sentinel/storage
    assert_eq!(metas[3].pubkey, fallback_composite_ism_id());
}

/// Verify with composite fallback (MultisigMessageId root) and valid ECDSA sigs.
#[tokio::test]
async fn test_verify_composite_fallback_multisig_root_valid_sigs_accepts() {
    let mut context = program_test_with_composite_fallback()
        .start_with_context()
        .await;
    let payer = context.payer.insecure_clone();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_composite_ism(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::MultisigMessageId {
            validators: test_validators(),
            threshold: 2,
        },
    )
    .await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_composite_ism_id(),
        },
    )
    .await
    .unwrap();

    let message = test_message();
    let checkpoint = test_checkpoint(&message);
    let sigs = test_signatures();
    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&sigs[0]).unwrap(),
            EcdsaSignature::from_bytes(&sigs[1]).unwrap(),
        ],
    }
    .to_vec();

    let verify_ixn = VerifyInstruction {
        metadata: metadata.clone(),
        message: message.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn.clone())
            .await;

    assert_simulation_ok(
        &simulate_verify(&mut context.banks_client, &payer, bh, verify_ixn, metas).await,
    );
}

/// Verify with composite fallback (Test{accept:false}) is rejected.
#[tokio::test]
async fn test_verify_composite_fallback_test_root_rejects() {
    let mut context = program_test_with_composite_fallback()
        .start_with_context()
        .await;
    let payer = context.payer.insecure_clone();

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_composite_ism(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::Test { accept: false },
    )
    .await;

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        bh,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_composite_ism_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let bh = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas =
        get_all_verify_account_metas(&mut context.banks_client, &payer, bh, verify_ixn.clone())
            .await;

    assert!(
        simulate_verify(&mut context.banks_client, &payer, bh, verify_ixn, metas)
            .await
            .result
            .unwrap()
            .is_err(),
        "expected verify to fail via rejecting composite fallback"
    );
}
