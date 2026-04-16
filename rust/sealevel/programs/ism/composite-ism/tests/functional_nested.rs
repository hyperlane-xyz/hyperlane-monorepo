//! Functional tests for all ISM node types nested inside a `Routing` ISM.
//!
//! Each test initializes the VAM PDA with a bare `Routing` root and stores a
//! specific ISM in the per-domain PDA via `SetDomainIsm`.  This exercises the
//! full path: `VerifyAccountMetas` resolves the domain PDA, `Verify` reads the
//! sub-ISM from it, and — for `RateLimited` — writes the updated state back.
//!
//! ISM types covered:
//! - `TrustedRelayer` — signer check resolved through two-pass VAM
//! - `MultisigMessageId` — ECDSA threshold multisig
//! - `Aggregation` — m-of-n threshold over child ISMs in the domain PDA
//! - `AmountRouting` — token amount–based branching in the domain PDA
//! - `Pausable` — circuit breaker (unpaused + paused)
//! - `RateLimited` — rolling 24-hour limit; state persists in the domain PDA
//! - `Test` — trivial accept/reject (baseline)

mod common;

use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, H160, H256, U256};
use hyperlane_sealevel_composite_ism::{
    accounts::{DomainIsmAccount, IsmNode},
    error::Error,
    multisig_metadata::MultisigIsmMessageIdMetadata,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use solana_program::instruction::AccountMeta;
use solana_sdk::{
    instruction::{Instruction, InstructionError},
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};
use std::str::FromStr;

use common::{
    assert_simulation_error, assert_simulation_ok, composite_ism_id, domain_pda_key, dummy_message,
    encode_aggregation_metadata, get_all_verify_account_metas, initialize, program_test,
    set_domain_ism, simulate_verify, storage_pda_key, token_message_body,
};

const ORIGIN: u32 = 1234;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn routing_root() -> IsmNode {
    IsmNode::Routing { default_ism: None }
}

fn verify_ixn_empty(origin: u32) -> VerifyInstruction {
    let mut msg = dummy_message();
    msg.origin = origin;
    VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    }
}

// ─── TrustedRelayer ──────────────────────────────────────────────────────────

#[tokio::test]
async fn test_trusted_relayer_in_domain_pda_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();
    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
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

    // Fixpoint loop discovers: storage_pda → domain_pda → relayer(signer).
    let account_metas =
        get_all_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    assert_eq!(account_metas.len(), 3);
    assert_eq!(account_metas[2].pubkey, relayer.pubkey());
    assert!(account_metas[2].is_signer);

    // Simulate with relayer marked as signer.
    let mut msg2 = dummy_message();
    msg2.origin = ORIGIN;
    let verify_ixn2 = VerifyInstruction {
        metadata: vec![],
        message: msg2.to_vec(),
    };
    let result = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Verify(verify_ixn2)
                    .encode()
                    .unwrap(),
                account_metas,
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert_simulation_ok(&result);
}

// ─── MultisigMessageId ───────────────────────────────────────────────────────

fn multisig_validators() -> Vec<H160> {
    vec![
        H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
        H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
        H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
    ]
}

fn multisig_sigs() -> Vec<Vec<u8>> {
    vec![
        hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap(),
        hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap(),
    ]
}

fn multisig_test_message() -> hyperlane_core::HyperlaneMessage {
    hyperlane_core::HyperlaneMessage {
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

fn multisig_metadata(message: &hyperlane_core::HyperlaneMessage) -> Vec<u8> {
    let checkpoint = CheckpointWithMessageId {
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
    };
    let sigs = multisig_sigs();
    MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&sigs[0]).unwrap(),
            EcdsaSignature::from_bytes(&sigs[1]).unwrap(),
        ],
    }
    .to_vec()
}

#[tokio::test]
async fn test_multisig_in_domain_pda_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::MultisigMessageId {
            validators: multisig_validators(),
            threshold: 2,
        },
    )
    .await
    .unwrap();

    let message = multisig_test_message();
    let metadata = multisig_metadata(&message);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    // [storage_pda, domain_pda] — MultisigMessageId needs no extra accounts.
    assert_eq!(account_metas.len(), 2);

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

#[tokio::test]
async fn test_multisig_in_domain_pda_threshold_not_met() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::MultisigMessageId {
            validators: multisig_validators(),
            threshold: 2,
        },
    )
    .await
    .unwrap();

    let message = multisig_test_message();
    let sigs = multisig_sigs();
    let checkpoint = CheckpointWithMessageId {
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
    };
    // Duplicate sig[0] — can't satisfy second slot.
    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&sigs[0]).unwrap(),
            EcdsaSignature::from_bytes(&sigs[0]).unwrap(),
        ],
    }
    .to_vec();

    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::ThresholdNotMet as u32),
        ),
    );
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_aggregation_in_domain_pda_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();

    // 2-of-3 aggregation: first two sub-ISMs accept, third is not provided.
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: false },
            ],
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    // Provide metadata for sub-ISMs 0 and 1 only.
    let agg_meta = encode_aggregation_metadata(&[Some(&[]), Some(&[]), None]);
    let verify_ixn = VerifyInstruction {
        metadata: agg_meta,
        message: msg.to_vec(),
    };
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

#[tokio::test]
async fn test_aggregation_in_domain_pda_threshold_not_met() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();

    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    // Only provide metadata for sub-ISM 0 — threshold=2 not met.
    let agg_meta = encode_aggregation_metadata(&[Some(&[]), None]);
    let verify_ixn = VerifyInstruction {
        metadata: agg_meta,
        message: msg.to_vec(),
    };
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::ThresholdNotMet as u32),
        ),
    );
}

// ─── AmountRouting ───────────────────────────────────────────────────────────

#[tokio::test]
async fn test_amount_routing_in_domain_pda_routes_lower() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();

    // Threshold 1000: lower accepts, upper rejects.
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::AmountRouting {
            threshold: U256::from(1000u64),
            lower: Box::new(IsmNode::Test { accept: true }),
            upper: Box::new(IsmNode::Test { accept: false }),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    msg.body = token_message_body(500); // below threshold → lower (accept)
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

#[tokio::test]
async fn test_amount_routing_in_domain_pda_routes_upper() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();

    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::AmountRouting {
            threshold: U256::from(1000u64),
            lower: Box::new(IsmNode::Test { accept: true }),
            upper: Box::new(IsmNode::Test { accept: false }),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    msg.body = token_message_body(1000); // at threshold → upper (reject)
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}

// ─── Pausable ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_pausable_in_domain_pda_unpaused_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Pausable { paused: false },
    )
    .await
    .unwrap();

    let verify_ixn = verify_ixn_empty(ORIGIN);
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    assert_simulation_ok(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            account_metas,
        )
        .await,
    );
}

#[tokio::test]
async fn test_pausable_in_domain_pda_paused_rejects() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Pausable { paused: true },
    )
    .await
    .unwrap();

    let verify_ixn = verify_ixn_empty(ORIGIN);
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    assert_simulation_error(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            account_metas,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}

// ─── RateLimited (in domain PDA) ─────────────────────────────────────────────

/// Reads `(filled_level, last_updated)` directly from the domain PDA.
async fn read_domain_rate_limited_state(
    banks_client: &mut solana_program_test::BanksClient,
    domain: u32,
) -> (u64, i64) {
    let data = banks_client
        .get_account(domain_pda_key(domain))
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = DomainIsmAccount::fetch_data(&mut &data[..])
        .unwrap()
        .unwrap();
    match storage.ism.unwrap() {
        IsmNode::RateLimited {
            filled_level,
            last_updated,
            ..
        } => (filled_level, last_updated),
        _ => panic!("expected RateLimited node"),
    }
}

async fn process_verify_domain(
    banks_client: &mut solana_program_test::BanksClient,
    payer: &Keypair,
    verify_ixn: VerifyInstruction,
    account_metas: Vec<AccountMeta>,
) -> Result<(), solana_program_test::BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::Verify(verify_ixn)
            .encode()
            .unwrap(),
        account_metas,
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

#[tokio::test]
async fn test_rate_limited_in_domain_pda_initializes_full() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();

    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0, // normalized to max_capacity by SetDomainIsm
            last_updated: 0,
        },
    )
    .await
    .unwrap();

    let (filled_level, last_updated) =
        read_domain_rate_limited_state(&mut banks_client, ORIGIN).await;
    assert_eq!(filled_level, 1_000);
    assert_eq!(last_updated, 0);
}

#[tokio::test]
async fn test_rate_limited_in_domain_pda_domain_pda_is_writable() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    msg.body = token_message_body(100);
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    // After two VAM passes the domain PDA should be returned as writable.
    let account_metas =
        get_all_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert!(!account_metas[0].is_writable); // VAM PDA stays readonly (RateLimited is in domain PDA)
    assert_eq!(account_metas[1].pubkey, domain_pda_key(ORIGIN));
    assert!(account_metas[1].is_writable); // domain PDA must be writable for state writeback
}

#[tokio::test]
async fn test_rate_limited_in_domain_pda_enforces_limit() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
        },
    )
    .await
    .unwrap();

    let build_verify = |amount: u64| {
        let mut msg = dummy_message();
        msg.origin = ORIGIN;
        msg.body = token_message_body(amount);
        VerifyInstruction {
            metadata: vec![],
            message: msg.to_vec(),
        }
    };

    // First transfer: 600 — should succeed, leaving 400 remaining.
    let ixn = build_verify(600);
    let metas =
        get_all_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone())
            .await;
    process_verify_domain(&mut banks_client, &payer, ixn, metas)
        .await
        .unwrap();

    let (filled_level, _) = read_domain_rate_limited_state(&mut banks_client, ORIGIN).await;
    assert_eq!(filled_level, 400);

    // Second transfer: 400 — exactly the remaining capacity, should succeed.
    let ixn2 = build_verify(400);
    let metas2 =
        get_all_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn2.clone())
            .await;
    process_verify_domain(&mut banks_client, &payer, ixn2, metas2)
        .await
        .unwrap();

    let (filled_level2, _) = read_domain_rate_limited_state(&mut banks_client, ORIGIN).await;
    assert_eq!(filled_level2, 0);

    // Third transfer: 1 — capacity exhausted, should fail.
    let ixn3 = build_verify(1);
    let metas3 =
        get_all_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn3.clone())
            .await;
    let result = simulate_verify(&mut banks_client, &payer, recent_blockhash, ixn3, metas3).await;
    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_rate_limited_in_domain_pda_readonly_bypass_rejected() {
    // Verify that a hand-crafted transaction cannot bypass the rate limit by
    // presenting the domain PDA as readonly.  The program must reject such a
    // transaction rather than silently skipping the state writeback.
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    msg.body = token_message_body(500);
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    // Obtain the canonical account metas (domain PDA is writable).
    let mut metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;

    // Downgrade the domain PDA to readonly — simulating a malicious caller.
    for meta in &mut metas {
        if meta.pubkey == domain_pda_key(ORIGIN) {
            meta.is_writable = false;
        }
    }

    // The program must reject this, not silently skip the writeback.
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
        metas,
    )
    .await;
    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::DomainPdaNotWritable as u32),
        ),
    );
}

// ─── Test (baseline) ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_test_ism_in_domain_pda_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let verify_ixn = verify_ixn_empty(ORIGIN);
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    assert_simulation_ok(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            account_metas,
        )
        .await,
    );
}

#[tokio::test]
async fn test_test_ism_in_domain_pda_rejects() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(&mut banks_client, &payer, recent_blockhash, routing_root())
        .await
        .unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    let verify_ixn = verify_ixn_empty(ORIGIN);
    let account_metas = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;
    assert_simulation_error(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            account_metas,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}
