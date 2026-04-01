//! Functional tests for the Routing ISM node type.
//!
//! Routing selects a sub-ISM based on the message's origin domain and passes
//! metadata through unchanged. Falls back to default_ism if no route matches.
//!
//! Test cases:
//! - Verify succeeds by routing to the sub-ISM configured for the message's origin domain
//! - Verify succeeds via the default ISM when no explicit route matches the origin
//! - Verify fails with NoRouteForDomain when no route matches and no default is set
//! - VerifyAccountMetas returns the accounts of the sub-ISM selected for the message's origin

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
    initialize, program_test, simulate_verify, storage_pda_key,
};

const ORIGIN: u32 = 1234;
const OTHER_ORIGIN: u32 = 9999;

#[tokio::test]
async fn test_verify_matched_route() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            routes: vec![(ORIGIN, IsmNode::Test { accept: true })],
            default_ism: None,
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
async fn test_verify_uses_default_when_no_route_matches() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            routes: vec![(OTHER_ORIGIN, IsmNode::Test { accept: false })],
            default_ism: Some(Box::new(IsmNode::Test { accept: true })),
        },
    )
    .await
    .unwrap();

    // Message origin doesn't match OTHER_ORIGIN — falls back to default (accept=true).
    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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
async fn test_verify_no_route_for_domain() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            routes: vec![(OTHER_ORIGIN, IsmNode::Test { accept: true })],
            default_ism: None,
        },
    )
    .await
    .unwrap();

    // No route for ORIGIN and no default.
    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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
            InstructionError::Custom(Error::NoRouteForDomain as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_account_metas_returns_selected_branch_accounts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();

    // Route for ORIGIN uses TrustedRelayer; route for OTHER_ORIGIN uses Test.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            routes: vec![
                (
                    ORIGIN,
                    IsmNode::TrustedRelayer {
                        relayer: relayer.pubkey(),
                    },
                ),
                (OTHER_ORIGIN, IsmNode::Test { accept: true }),
            ],
            default_ism: None,
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
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, relayer (signer)] — only the ORIGIN branch's accounts.
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, relayer.pubkey());
    assert!(account_metas[1].is_signer);
}
