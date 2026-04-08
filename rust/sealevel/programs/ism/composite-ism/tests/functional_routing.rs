//! Functional tests for the Routing ISM node type.
//!
//! Routing stores each domain's ISM in a per-domain PDA account.
//! Only the PDA for the incoming message's origin domain is loaded at verify
//! time, keeping heap usage O(1) regardless of how many domains are configured.
//!
//! CONFIG:
//! - Initialize stores the Routing root node (with table_id and optional
//!   default_ism) in the VAM PDA.
//! - SetDomainIsm creates or updates the per-domain PDA for a given origin.
//! - RemoveDomainIsm closes the per-domain PDA, reverting to the default_ism.
//!
//! VERIFY:
//! - Verify succeeds when a domain PDA exists for the message's origin.
//! - Verify succeeds via default_ism when no domain PDA exists.
//! - Verify fails NoRouteForDomain when no domain PDA and no default_ism.
//! - After RemoveDomainIsm, Verify falls back to default_ism.
//!
//! VERIFY ACCOUNT METAS:
//! - Pass 1: returns [storage_pda, domain_pda].
//! - Pass 2 (TrustedRelayer in domain PDA): caller feeds domain_pda back;
//!   handler reads it and appends the relayer pubkey.

mod common;

use hyperlane_core::Encode;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_sdk::{
    instruction::InstructionError, signature::Signer, signer::keypair::Keypair,
    transaction::TransactionError,
};

use common::{
    assert_simulation_error, assert_simulation_ok, domain_pda_key, dummy_message,
    get_all_verify_account_metas, get_verify_account_metas, initialize, program_test,
    remove_domain_ism, set_domain_ism, simulate_verify, storage_pda_key,
};

const ORIGIN: u32 = 1234;
const OTHER_ORIGIN: u32 = 9999;

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let root = IsmNode::Routing { default_ism: None };
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
async fn test_set_domain_ism_creates_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
    .await
    .unwrap();

    // Domain PDA should not exist yet.
    assert!(banks_client
        .get_account(domain_pda_key(ORIGIN))
        .await
        .unwrap()
        .is_none());

    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // Domain PDA should now exist.
    assert!(banks_client
        .get_account(domain_pda_key(ORIGIN))
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn test_remove_domain_ism_closes_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            default_ism: Some(Box::new(IsmNode::Test { accept: true })),
        },
    )
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

    remove_domain_ism(&mut banks_client, &payer, recent_blockhash, ORIGIN)
        .await
        .unwrap();

    assert!(banks_client
        .get_account(domain_pda_key(ORIGIN))
        .await
        .unwrap()
        .is_none());
}

// ── VERIFY ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_via_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
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

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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
async fn test_verify_rejects_via_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
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

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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

#[tokio::test]
async fn test_verify_uses_default_when_no_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // default_ism accepts; no domain PDA for ORIGIN.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            default_ism: Some(Box::new(IsmNode::Test { accept: true })),
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
async fn test_verify_no_route_for_domain() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // No domain PDA, no default_ism.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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
            InstructionError::Custom(Error::NoRouteForDomain as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_falls_back_after_remove_domain_ism() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing {
            default_ism: Some(Box::new(IsmNode::Test { accept: true })),
        },
    )
    .await
    .unwrap();

    // Set domain PDA to reject.
    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // Remove it — should fall back to the accepting default_ism.
    remove_domain_ism(&mut banks_client, &payer, recent_blockhash, ORIGIN)
        .await
        .unwrap();

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
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

// ── VERIFY ACCOUNT METAS ─────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_account_metas_returns_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
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

    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, domain_pda]
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, domain_pda_key(ORIGIN));
    assert!(!account_metas[1].is_signer);
    assert!(!account_metas[1].is_writable);
}

#[tokio::test]
async fn test_verify_account_metas_trusted_relayer_in_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
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
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert_eq!(account_metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(account_metas[2].pubkey, relayer.pubkey());
    assert!(account_metas[2].is_signer);
}

#[tokio::test]
async fn test_verify_account_metas_different_origins_independent() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing { default_ism: None },
    )
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

    set_domain_ism(
        &mut banks_client,
        &payer,
        recent_blockhash,
        OTHER_ORIGIN,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // ORIGIN → accept.
    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let metas = get_all_verify_account_metas(
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
            metas,
        )
        .await,
    );

    // OTHER_ORIGIN → reject.
    msg.origin = OTHER_ORIGIN;
    let verify_ixn2 = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let metas2 = get_all_verify_account_metas(
        &mut banks_client,
        &payer,
        recent_blockhash,
        verify_ixn2.clone(),
    )
    .await;
    assert_simulation_error(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn2,
            metas2,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}
