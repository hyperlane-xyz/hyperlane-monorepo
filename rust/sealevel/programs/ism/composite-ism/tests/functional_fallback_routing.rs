//! Functional tests for the FallbackRouting ISM node type.
//!
//! FallbackRouting acts like Routing when a domain ISM is configured for the
//! incoming message's origin.  When no domain ISM exists, it falls back to a
//! statically-configured ISM program whose address is stored directly in the
//! node (`fallback_ism`).
//!
//! The fallback ISM can be *any* program that implements the standard ISM
//! interface (Verify, VerifyAccountMetas).  It does not need to be a composite
//! ISM.  In these tests we register a second instance of the composite ISM
//! binary under `fallback_ism_id()` to act as the fallback so that CPI calls
//! succeed under BanksClient.
//!
//! VERIFY:
//! - Domain ISM path: accepts / rejects based on the configured domain ISM.
//! - Fallback path: delegates to the configured fallback ISM (accepts / rejects).
//! - After RemoveDomainIsm: falls back to the configured fallback ISM.
//!
//! VERIFY ACCOUNT METAS (fixpoint convergence):
//! - Domain ISM present:  converges at [storage_pda, domain_pda].
//! - No domain ISM:       converges at [storage_pda, domain_pda, fallback_storage_pda].

mod common;

use hyperlane_core::Encode;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
    instruction::initialize_instruction,
    processor::process_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use solana_program::pubkey::Pubkey;
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    hash::Hash,
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use common::{
    assert_simulation_error, assert_simulation_ok, domain_pda_key, dummy_message,
    get_all_verify_account_metas, get_verify_account_metas, initialize, program_test,
    remove_domain_ism, set_domain_ism, simulate_verify, storage_pda_key,
};

const ORIGIN: u32 = 1234;

/// Fixed program ID for the second composite ISM instance used as the fallback.
fn fallback_ism_id() -> Pubkey {
    Pubkey::new_from_array([2u8; 32])
}

/// The VAM storage PDA for the fallback ISM program.
fn fallback_storage_pda_key() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &fallback_ism_id()).0
}

/// Returns a ProgramTest with both the main composite ISM and the fallback
/// composite ISM registered (same binary, different program IDs).
fn program_test_with_fallback() -> ProgramTest {
    let mut test = program_test();
    test.add_program(
        "hyperlane_sealevel_composite_ism",
        fallback_ism_id(),
        processor!(process_instruction),
    );
    test
}

/// Initializes the fallback ISM program with the given root ISM node.
async fn setup_fallback_ism(
    banks_client: &mut solana_program_test::BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    fallback_root: IsmNode,
) {
    let ix = initialize_instruction(fallback_ism_id(), payer.pubkey(), fallback_root).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let fallback_ism = Pubkey::new_unique();
    let root = IsmNode::FallbackRouting { fallback_ism };
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

    assert_eq!(storage.root, Some(root));
}

#[tokio::test]
async fn test_set_domain_ism_creates_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: Pubkey::new_unique(),
        },
    )
    .await
    .unwrap();

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
        IsmNode::FallbackRouting {
            fallback_ism: Pubkey::new_unique(),
        },
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

    remove_domain_ism(&mut banks_client, &payer, recent_blockhash, ORIGIN)
        .await
        .unwrap();

    assert!(banks_client
        .get_account(domain_pda_key(ORIGIN))
        .await
        .unwrap()
        .is_none());
}

// ── VERIFY (domain ISM path) ─────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_via_domain_pda_accepts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: Pubkey::new_unique(),
        },
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
}

#[tokio::test]
async fn test_verify_via_domain_pda_rejects() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: Pubkey::new_unique(),
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
    assert_simulation_error(
        &simulate_verify(
            &mut banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            metas,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}

// ── VERIFY (fallback path) ───────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_via_fallback_ism_accepts() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_ism_id(),
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

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas = get_all_verify_account_metas(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;

    assert_simulation_ok(
        &simulate_verify(
            &mut context.banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            metas,
        )
        .await,
    );
}

#[tokio::test]
async fn test_verify_via_fallback_ism_rejects() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_ism_id(),
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

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas = get_all_verify_account_metas(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;

    assert_simulation_error(
        &simulate_verify(
            &mut context.banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            metas,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::VerifyRejected as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_falls_back_after_remove_domain_ism() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_ism_id(),
        },
    )
    .await
    .unwrap();

    // Set domain ISM to reject.
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    set_domain_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // Remove it — now there is no domain ISM for ORIGIN.
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    remove_domain_ism(&mut context.banks_client, &payer, recent_blockhash, ORIGIN)
        .await
        .unwrap();

    // Verify should succeed via the accepting fallback ISM.
    let mut msg = dummy_message();
    msg.origin = ORIGIN;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas = get_all_verify_account_metas(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        verify_ixn.clone(),
    )
    .await;

    assert_simulation_ok(
        &simulate_verify(
            &mut context.banks_client,
            &payer,
            recent_blockhash,
            verify_ixn,
            metas,
        )
        .await,
    );
}

// ── VERIFY ACCOUNT METAS ─────────────────────────────────────────────────────

#[tokio::test]
async fn test_vam_domain_ism_present_returns_domain_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: Pubkey::new_unique(),
        },
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
    let metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // [storage_pda, domain_pda] — identical to Routing when domain ISM is present.
    assert_eq!(metas.len(), 2);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert!(!metas[1].is_signer);
    assert!(!metas[1].is_writable);
}

#[tokio::test]
async fn test_vam_no_domain_ism_returns_fallback_storage() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_ism_id(),
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

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let metas = get_all_verify_account_metas(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        verify_ixn,
    )
    .await;

    // [storage_pda, domain_pda, fallback_storage_pda, fallback_ism_program]
    // The fallback ISM program account is required so the CPI inside VerifyAccountMetas
    // and Verify can locate the callee in the outer instruction's accounts list.
    assert_eq!(metas.len(), 4);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key());
    assert_eq!(metas[3].pubkey, fallback_ism_id());
}
