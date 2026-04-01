//! Functional tests for the Pausable ISM node type.
//!
//! CONFIG:
//! - Initialize stores the Pausable root node in the PDA
//! - Type returns ModuleType::Null
//!
//! VERIFY:
//! - Verify succeeds when the root is Pausable { paused: false }
//! - Verify fails with VerifyRejected when the root is Pausable { paused: true }
//! - VerifyAccountMetas returns only the storage PDA with no extra accounts

mod common;

use borsh::BorshDeserialize;
use hyperlane_core::{Encode, ModuleType};
use hyperlane_sealevel_composite_ism::accounts::{CompositeIsmAccount, IsmNode};
use hyperlane_sealevel_composite_ism::error::Error;
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_sdk::{instruction::InstructionError, signature::Signer, transaction::TransactionError};

use common::{
    assert_simulation_error, assert_simulation_ok, dummy_message, get_ism_type,
    get_verify_account_metas, initialize, program_test, simulate_verify, storage_pda_key,
};

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let root = IsmNode::Pausable { paused: false };
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
async fn test_ism_type() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Pausable { paused: false },
    )
    .await
    .unwrap();

    assert_eq!(
        get_ism_type(&mut banks_client, &payer, recent_blockhash).await,
        ModuleType::Null,
    );
}

// ── VERIFY ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_unpaused() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Pausable { paused: false },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
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
async fn test_verify_paused() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Pausable { paused: true },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
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
async fn test_verify_account_metas_empty() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Pausable { paused: false },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // Only the storage PDA — no extra accounts for Pausable ISM.
    assert_eq!(account_metas.len(), 1);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
}
