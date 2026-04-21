//! Functional tests for the FallbackRouting ISM node type.
//!
//! FallbackRouting acts like Routing when a domain ISM is configured for the
//! incoming message's origin.  When no domain ISM exists, it falls back to a
//! statically-configured composite ISM whose address is stored directly in the
//! node (`fallback_ism`).
//!
//! Unlike the old mailbox-indirection design, no mailbox inbox PDA is needed
//! at verify time.  This avoids the `AccountBorrowFailed` conflict that arose
//! because the mailbox intentionally holds a `RefMut` on the inbox PDA as a
//! reentrancy guard for the entire duration of `process` — including across the
//! ISM Verify CPI.  Because that guard was never taken in the isolated
//! `simulate_verify` tests, the borrow conflict was never caught here; it only
//! manifested when the mailbox actually called `Verify` during `process`.
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
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_program::pubkey::Pubkey;
use solana_program_test::ProgramTestContext;
use solana_sdk::{
    account::{Account, AccountSharedData},
    instruction::InstructionError,
    signature::Signer,
    transaction::TransactionError,
};

use common::{
    assert_simulation_error, assert_simulation_ok, domain_pda_key, dummy_message,
    get_all_verify_account_metas, get_verify_account_metas, initialize, make_fallback_storage_data,
    program_test, remove_domain_ism, set_domain_ism, simulate_verify, storage_pda_key,
};

const ORIGIN: u32 = 1234;

/// Inserts the fallback composite ISM storage PDA into the test bank.
///
/// Returns the fallback storage PDA key.
fn setup_fallback_ism(
    context: &mut ProgramTestContext,
    fallback_program_id: &Pubkey,
    fallback_root: IsmNode,
) -> Pubkey {
    let (fallback_storage_key, fallback_data) =
        make_fallback_storage_data(fallback_program_id, Some(fallback_root));
    context.set_account(
        &fallback_storage_key,
        &AccountSharedData::from(Account {
            lamports: 10_000_000,
            data: fallback_data,
            owner: *fallback_program_id,
            executable: false,
            rent_epoch: 0,
        }),
    );
    fallback_storage_key
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
    let fallback_program_id = Pubkey::new_unique();

    let mut context = program_test().start_with_context().await;
    setup_fallback_ism(
        &mut context,
        &fallback_program_id,
        IsmNode::Test { accept: true },
    );

    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_program_id,
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
    let fallback_program_id = Pubkey::new_unique();

    let mut context = program_test().start_with_context().await;
    setup_fallback_ism(
        &mut context,
        &fallback_program_id,
        IsmNode::Test { accept: false },
    );

    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_program_id,
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
    let fallback_program_id = Pubkey::new_unique();

    let mut context = program_test().start_with_context().await;
    setup_fallback_ism(
        &mut context,
        &fallback_program_id,
        IsmNode::Test { accept: true },
    );

    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_program_id,
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
    let fallback_program_id = Pubkey::new_unique();

    let mut context = program_test().start_with_context().await;
    let fallback_storage_pda_key = setup_fallback_ism(
        &mut context,
        &fallback_program_id,
        IsmNode::Test { accept: true },
    );

    let payer = context.payer.insecure_clone();
    let recent_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    initialize(
        &mut context.banks_client,
        &payer,
        recent_blockhash,
        IsmNode::FallbackRouting {
            fallback_ism: fallback_program_id,
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

    // [storage_pda, domain_pda, fallback_storage_pda] — no inbox PDA.
    assert_eq!(metas.len(), 3);
    assert_eq!(metas[0].pubkey, storage_pda_key());
    assert_eq!(metas[1].pubkey, domain_pda_key(ORIGIN));
    assert_eq!(metas[2].pubkey, fallback_storage_pda_key);
}
