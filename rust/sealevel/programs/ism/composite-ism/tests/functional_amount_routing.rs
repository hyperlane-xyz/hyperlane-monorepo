//! Functional tests for the AmountRouting ISM node type.
//!
//! AmountRouting reads the token amount from message body bytes [32..64] (big-endian u256)
//! and routes to `lower` if amount < threshold, or `upper` if amount >= threshold.
//! This mirrors the TokenMessage format used in warp route transfers.
//!
//! Test cases:
//! - Verify routes to `lower` (accept=true) when amount < threshold
//! - Verify routes to `upper` (accept=false) when amount == threshold (boundary)
//! - Verify routes to `upper` (accept=false) when amount > threshold
//! - Verify fails with InvalidMessageBody when message body is shorter than 64 bytes
//! - VerifyAccountMetas returns accounts for the `lower` branch when amount < threshold
//! - VerifyAccountMetas returns accounts for the `upper` branch when amount >= threshold

mod common;

use hyperlane_core::Encode;
use hyperlane_sealevel_composite_ism::{accounts::IsmNode, error::Error};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_sdk::{
    instruction::InstructionError, signature::Signer, signer::keypair::Keypair,
    transaction::TransactionError,
};

use common::{
    assert_simulation_error, assert_simulation_ok, dummy_message, get_verify_account_metas,
    initialize, program_test, simulate_verify, storage_pda_key, token_message_body,
};

/// Builds an AmountRouting node with `lower = Test{accept:true}`, `upper = Test{accept:false}`.
fn amount_routing_node(threshold_value: u64) -> IsmNode {
    let mut threshold = [0u8; 32];
    threshold[24..32].copy_from_slice(&threshold_value.to_be_bytes());
    IsmNode::AmountRouting {
        threshold,
        lower: Box::new(IsmNode::Test { accept: true }),
        upper: Box::new(IsmNode::Test { accept: false }),
    }
}

#[tokio::test]
async fn test_verify_amount_below_threshold_routes_lower() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let threshold = 1000u64;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        amount_routing_node(threshold),
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(threshold - 1); // 999 < 1000 → lower (accept=true)

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
async fn test_verify_amount_at_threshold_routes_upper() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let threshold = 1000u64;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        amount_routing_node(threshold),
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(threshold); // 1000 >= 1000 → upper (accept=false)

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
async fn test_verify_amount_above_threshold_routes_upper() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let threshold = 1000u64;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        amount_routing_node(threshold),
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(threshold + 5000); // well above threshold → upper (accept=false)

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
async fn test_verify_body_too_short() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        amount_routing_node(1000),
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = vec![0u8; 10]; // body needs at least 64 bytes

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
            InstructionError::Custom(Error::InvalidMessageBody as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_account_metas_lower_branch() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer_lower = Keypair::new();
    let relayer_upper = Keypair::new();
    let threshold = 1000u64;
    let mut threshold_bytes = [0u8; 32];
    threshold_bytes[24..32].copy_from_slice(&threshold.to_be_bytes());

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::AmountRouting {
            threshold: threshold_bytes,
            lower: Box::new(IsmNode::TrustedRelayer {
                relayer: relayer_lower.pubkey(),
            }),
            upper: Box::new(IsmNode::TrustedRelayer {
                relayer: relayer_upper.pubkey(),
            }),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(threshold - 1); // amount < threshold → lower branch

    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, relayer_lower (signer)] — upper branch is not selected.
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, relayer_lower.pubkey());
    assert!(account_metas[1].is_signer);
}

#[tokio::test]
async fn test_verify_account_metas_upper_branch() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer_lower = Keypair::new();
    let relayer_upper = Keypair::new();
    let threshold = 1000u64;
    let mut threshold_bytes = [0u8; 32];
    threshold_bytes[24..32].copy_from_slice(&threshold.to_be_bytes());

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::AmountRouting {
            threshold: threshold_bytes,
            lower: Box::new(IsmNode::TrustedRelayer {
                relayer: relayer_lower.pubkey(),
            }),
            upper: Box::new(IsmNode::TrustedRelayer {
                relayer: relayer_upper.pubkey(),
            }),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(threshold); // amount >= threshold → upper branch

    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, relayer_upper (signer)] — lower branch is not selected.
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, relayer_upper.pubkey());
    assert!(account_metas[1].is_signer);
}
