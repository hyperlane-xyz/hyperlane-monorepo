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
    accounts::{derive_domain_pda, CompositeIsmAccount, IsmNode},
    error::Error,
    instruction::{initialize_instruction, set_domain_ism_instruction},
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
    get_all_verify_account_metas, get_metadata_spec, get_verify_account_metas, initialize,
    mock_mailbox_id, process_verify_via_mailbox, program_test, remove_domain_ism, set_domain_ism,
    simulate_verify, storage_pda_key, token_message_body,
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

    // [storage_pda, domain_pda, fallback_storage_pda (sentinel/fallback VAM PDA), fallback_ism_program]
    // fallback_storage_pda appears exactly once: it is both the fixpoint sentinel (keeping
    // the loop in Pass 3+) and the fallback ISM's VAM PDA forwarded to its Verify handler.
    // The inner ISM's VAM result also starts with its own VAM PDA; we skip that first element
    // (skip(1)) to avoid a duplicate that would corrupt the inner ISM's account discovery.
    assert_eq!(metas.len(), 4);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key());
    assert_eq!(metas[3].pubkey, fallback_ism_id());
}

// ── Regression: sentinel convergence with non-empty fallback ISM accounts ─────
//
// When the fallback ISM returns non-empty accounts from VerifyAccountMetas
// (e.g. TrustedRelayer), the fixpoint loop previously oscillated: Pass 3+
// output did not include fallback_storage_key, so the next iteration re-entered
// Pass 2 and produced a different set, cycling forever.  The fix adds
// fallback_storage_key as a sentinel in Pass 3+ output so subsequent iterations
// always satisfy the fallback_provided check and stay in Pass 3+.

#[tokio::test]
async fn test_vam_fallback_with_extra_accounts_converges() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let relayer = Keypair::new();

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
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

    // Converged set:
    // [storage_pda, domain_pda, fallback_storage (sentinel/fallback VAM PDA), relayer, fallback_ism]
    // fallback_storage appears once: the inner TrustedRelayer VAM result starts with the fallback
    // VAM PDA; skip(1) removes that duplicate so the sentinel at [2] is the only copy.
    assert_eq!(metas.len(), 5);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key());
    assert_eq!(metas[3].pubkey, relayer.pubkey());
    assert!(metas[3].is_signer, "relayer must be marked as signer");
    assert_eq!(metas[4].pubkey, fallback_ism_id());
}

#[tokio::test]
async fn test_verify_via_fallback_ism_with_trusted_relayer_accepts() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let relayer = Keypair::new();

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
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

// ── Regression: VerifyMetadataSpec when fallback ISM is a composite ISM ──────
//
// Previously the Type CPI was invoked with 0 accounts.  The inner composite
// ISM's Type handler calls next_account_info → NotEnoughAccountKeys → the
// relayer reported "insufficient account keys for instruction".
// Fix: pass the fallback's VAM/storage PDA as accounts[0] to the Type CPI.

#[tokio::test]
async fn test_metadata_spec_fallback_composite_ism_converges() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    let validators = vec![hyperlane_core::H160::random()];
    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::MultisigMessageId {
            validators: validators.clone(),
            threshold: 1,
        },
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

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let result = get_metadata_spec(&mut context.banks_client, &payer, recent_blockhash, &msg)
        .await
        .expect("VerifyMetadataSpec fixpoint did not converge");

    match result.spec {
        Some(
            hyperlane_sealevel_interchain_security_module_interface::MetadataSpec::MultisigMessageId {
                validators: v,
                threshold: t,
            },
        ) => {
            assert_eq!(v, validators);
            assert_eq!(t, 1);
        }
        other => panic!("expected MultisigMessageId spec, got {:?}", other),
    }
}

// ── Regression: FallbackRouting → Routing → TrustedRelayer ───────────────────
//
// When the fallback ISM itself contains a Routing node, the outer FallbackRouting
// must forward the correct accounts to the inner ISM's VerifyAccountMetas so that
// the Routing node can discover its sub-accounts (e.g. a TrustedRelayer).
//
// The bug: without the skip(1) fix in account_metas.rs, the outer code prepended
// fallback_storage_key as a sentinel AND the inner ISM's result also started with
// fallback_storage_key, creating a duplicate.  The duplicate shifted inner
// extra_accounts by one, so the inner Routing node always saw the wrong account
// at [0] and never entered its domain-PDA discovery pass.  The fixpoint converged
// without the TrustedRelayer account, making Verify fail with InvalidRelayer.
//
// After the fix: skip(1) removes the duplicate; the inner Routing node correctly
// discovers its domain PDA and the TrustedRelayer account on subsequent passes.

/// Sets a domain ISM directly on the fallback ISM program (not on the outer ISM).
async fn set_fallback_ism_domain_ism(
    banks_client: &mut solana_program_test::BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    domain: u32,
    ism: IsmNode,
) {
    let ix = set_domain_ism_instruction(fallback_ism_id(), payer.pubkey(), domain, ism).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

#[tokio::test]
async fn test_vam_fallback_with_inner_routing_discovers_trusted_relayer() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let relayer = Keypair::new();

    // B (fallback ISM) has Routing as root with TrustedRelayer for ORIGIN.
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing,
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    set_fallback_ism_domain_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await;

    // A (outer ISM) delegates to B via FallbackRouting (no domain ISM for ORIGIN on A).
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

    // Converged set:
    // [A_vam, A_domain_pda, B_vam (sentinel), B_domain_pda, relayer, B_id]
    // B_domain_pda is B's per-domain PDA for ORIGIN (holds TrustedRelayer).
    // Without the skip(1) fix the duplicate B_vam would prevent B's Routing node
    // from entering its domain-PDA discovery pass, so the relayer would be missing.
    let b_domain_pda = derive_domain_pda(&fallback_ism_id(), ORIGIN).0;
    assert_eq!(metas.len(), 6);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key());
    assert_eq!(metas[3].pubkey, b_domain_pda);
    assert_eq!(metas[4].pubkey, relayer.pubkey());
    assert!(metas[4].is_signer, "relayer must be marked as signer");
    assert_eq!(metas[5].pubkey, fallback_ism_id());
}

#[tokio::test]
async fn test_verify_fallback_with_inner_routing_and_trusted_relayer_accepts() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let relayer = Keypair::new();

    // B (fallback ISM) has Routing as root with TrustedRelayer for ORIGIN.
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Routing,
    )
    .await;

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    set_fallback_ism_domain_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        ORIGIN,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await;

    // A (outer ISM) delegates to B via FallbackRouting.
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

// ── Regression: FallbackRouting → RateLimited fallback preserves writable flag ──
//
// When the fallback ISM contains a RateLimited node, its all_verify_account_metas
// returns the storage PDA as writable (it must be written during Verify to update
// filled_level/last_updated).  The old dedup silently dropped the writable copy and
// kept only the read-only sentinel, causing DomainPdaNotWritable at Verify time.
//
// The fix: merge is_writable/is_signer from the inner ISM's first element into the
// retained sentinel instead of discarding it.

#[tokio::test]
async fn test_vam_fallback_with_rate_limited_storage_is_writable() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::RateLimited {
            max_capacity: 1_000_000,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
            mailbox: mock_mailbox_id(),
        },
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
    msg.body = token_message_body(100);
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

    // [storage_pda, domain_pda, fallback_storage_pda (writable), process_authority (signer), fallback_ism]
    // The sentinel for fallback_storage_pda must be writable because RateLimited writes
    // filled_level/last_updated to the storage PDA during Verify.
    assert_eq!(metas.len(), 5);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key());
    assert!(
        metas[2].is_writable,
        "fallback storage must be writable for RateLimited"
    );
    assert!(metas[3].is_signer, "process authority must be signer");
    assert_eq!(metas[4].pubkey, fallback_ism_id());
}

#[tokio::test]
async fn test_verify_fallback_with_rate_limited_accepts_within_capacity() {
    let mut context = program_test_with_fallback().start_with_context().await;
    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    setup_fallback_ism(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::RateLimited {
            max_capacity: 1_000_000,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
            mailbox: mock_mailbox_id(),
        },
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
    msg.body = token_message_body(100);
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

    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    process_verify_via_mailbox(&mut context.banks_client, &payer, verify_ixn, metas)
        .await
        .unwrap();
}
