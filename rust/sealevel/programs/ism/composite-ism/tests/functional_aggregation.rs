//! Functional tests for the Aggregation ISM node type.
//!
//! Aggregation requires at least `threshold` sub-ISMs to have metadata provided,
//! and ALL sub-ISMs that do have metadata must pass verification.
//!
//! CONFIG:
//! - Initialize stores the Aggregation root node in the PDA
//! - Initialize fails with InvalidConfig when threshold > sub_isms.len()
//!
//! VERIFY:
//! - Verify succeeds when all sub-ISMs have metadata and all pass (threshold=2, 2-of-2)
//! - Verify succeeds when only the threshold subset provides metadata and all pass (threshold=1, 1-of-2)
//! - Verify fails with ThresholdNotMet when fewer sub-ISMs than threshold provide metadata
//! - Verify fails when a sub-ISM with metadata rejects (one Test{accept:false} in the set)
//! - VerifyAccountMetas returns the union of accounts from sub-ISMs that have metadata

mod common;

use hyperlane_core::Encode;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use hyperlane_test_utils::assert_transaction_error;
use solana_sdk::{
    instruction::InstructionError, signature::Signer, signer::keypair::Keypair,
    transaction::TransactionError,
};

use common::{
    assert_simulation_error, assert_simulation_ok, dummy_message, encode_aggregation_metadata,
    get_verify_account_metas, initialize, program_test, simulate_verify, storage_pda_key,
};

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let root = IsmNode::Aggregation {
        threshold: 1,
        sub_isms: vec![IsmNode::Test { accept: true }],
    };
    initialize(&mut banks_client, &payer, recent_blockhash, root.clone())
        .await
        .unwrap();

    let storage_data = banks_client
        .get_account(storage_pda_key())
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = CompositeIsmAccount::fetch_data(&mut &storage_data[..])
        .unwrap()
        .unwrap();

    assert_eq!(storage.owner, Some(payer.pubkey()));
    assert_eq!(storage.root, Some(root));
}

#[tokio::test]
async fn test_initialize_invalid_config() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // threshold > sub_isms.len() is invalid.
    let result = initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Aggregation {
            threshold: 3,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        },
    )
    .await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::InvalidConfig as u32),
        ),
    );
}

// ── VERIFY ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_all_provided() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
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

    let msg = dummy_message();
    // Both sub-ISMs have (empty) metadata.
    let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);
    let verify_ixn = VerifyInstruction {
        metadata: metadata.clone(),
        message: msg.to_vec(),
    };
    let account_metas = get_verify_account_metas(
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
async fn test_verify_subset_provided_threshold_met() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // threshold=1: only sub-ISM 0 needs to provide metadata.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    // Only sub-ISM 0 provides metadata; sub-ISM 1 is skipped (start=0).
    let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: msg.to_vec(),
    };
    let account_metas = get_verify_account_metas(
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
async fn test_verify_threshold_not_met() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // threshold=2 but only 1 sub-ISM provides metadata.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
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

    let msg = dummy_message();
    let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: msg.to_vec(),
    };
    let account_metas = get_verify_account_metas(
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

#[tokio::test]
async fn test_verify_sub_ism_rejects() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // sub-ISM 0 accepts, sub-ISM 1 rejects — but sub-ISM 1 has metadata, so it must pass.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: false },
            ],
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    // Both sub-ISMs provide metadata — both must pass, but sub-ISM 1 will reject.
    let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: msg.to_vec(),
    };
    let account_metas = get_verify_account_metas(
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

#[tokio::test]
async fn test_verify_account_metas_union_of_active_sub_isms() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer_a = Keypair::new();
    let relayer_b = Keypair::new();

    // sub-ISM 0: TrustedRelayer(A), sub-ISM 1: TrustedRelayer(B)
    // Only sub-ISM 0 will have metadata — so only relayer_a should appear in account metas.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::TrustedRelayer {
                    relayer: relayer_a.pubkey(),
                },
                IsmNode::TrustedRelayer {
                    relayer: relayer_b.pubkey(),
                },
            ],
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    // Only sub-ISM 0 has metadata.
    let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, relayer_a] — relayer_b is excluded because sub-ISM 1 has no metadata.
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, relayer_a.pubkey());
    assert!(account_metas[1].is_signer);
}
