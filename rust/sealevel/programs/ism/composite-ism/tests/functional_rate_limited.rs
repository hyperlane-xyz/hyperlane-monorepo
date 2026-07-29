//! Functional tests for the RateLimited ISM node type.
//!
//! Enforces a rolling 24-hour transfer limit on token amounts in messages.
//! State (filled_level, last_updated) is stored inline in the VAM PDA.
//!
//! CONFIG:
//! - Initialize normalizes filled_level to max_capacity and last_updated to 0
//!
//! VERIFY:
//! - Verify succeeds and decrements filled_level when amount is within capacity
//! - Verify succeeds when amount equals the full remaining capacity
//! - Verify fails with RateLimitExceeded when amount exceeds available capacity
//! - Sequential verifies track remaining capacity correctly
//! - After a partial time elapsed, partial refill allows additional transfers
//! - After a full 24-hour window, capacity is fully restored
//! - Verify fails with RecipientMismatch when recipient does not match the configured one
//! - Initialize fails when recipient is None (RateLimited requires a warp-route address)
//! - Verify fails with InvalidMessageBody when message body is shorter than 64 bytes
//! - Verify fails with RateLimitExceeded when message amount overflows u64 (high bytes non-zero)
//! - VerifyAccountMetas returns the storage PDA as writable (state is mutated on Verify)
//! - UpdateConfig resets rate limit state to full capacity

mod common;

use hyperlane_core::{Encode, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
    instruction::update_config_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_program_test::{BanksClient, BanksClientError};
use solana_sdk::{
    clock::Clock,
    hash::Hash,
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use common::{
    assert_simulation_error, composite_ism_id, dummy_message, get_verify_account_metas, initialize,
    mock_mailbox_id, process_verify_via_mailbox, program_test, simulate_verify, storage_pda_key,
    token_message_body,
};

const MAX_CAPACITY: u64 = 1_000;
// A fixed warp-route contract address used as the configured recipient in tests.
const WARP_ROUTE: H256 = H256([0x11u8; 32]);

fn rate_limited_node(max_capacity: u64) -> IsmNode {
    IsmNode::RateLimited {
        max_capacity,
        recipient: Some(WARP_ROUTE),
        filled_level: 0, // normalized to max_capacity on initialize
        last_updated: 0,
        mailbox: mock_mailbox_id(),
    }
}

fn verify_ixn(amount: u64) -> VerifyInstruction {
    let mut msg = dummy_message();
    msg.recipient = WARP_ROUTE;
    msg.body = token_message_body(amount);
    VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    }
}

async fn read_rate_limited_state(banks_client: &mut BanksClient) -> (u64, i64) {
    let data = banks_client
        .get_account(storage_pda_key())
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = CompositeIsmAccount::fetch_data(&mut &data[..])
        .unwrap()
        .unwrap();
    match storage.root.unwrap() {
        IsmNode::RateLimited {
            filled_level,
            last_updated,
            ..
        } => (filled_level, last_updated),
        _ => panic!("expected RateLimited node"),
    }
}

async fn update_config(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    root: IsmNode,
) -> Result<(), BanksClientError> {
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

fn clock_at(unix_timestamp: i64) -> Clock {
    Clock {
        slot: 1,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 1,
        unix_timestamp,
    }
}

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut banks_client).await;

    // normalize_node sets filled_level = max_capacity and last_updated = 0.
    assert_eq!(filled_level, MAX_CAPACITY);
    assert_eq!(last_updated, 0);
}

// ── VERIFY ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_below_capacity() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    let ixn = verify_ixn(500);
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    process_verify_via_mailbox(&mut banks_client, &payer, ixn, account_metas)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, MAX_CAPACITY - 500);
}

#[tokio::test]
async fn test_verify_exact_capacity() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    let ixn = verify_ixn(MAX_CAPACITY);
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    process_verify_via_mailbox(&mut banks_client, &payer, ixn, account_metas)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, 0);
}

#[tokio::test]
async fn test_verify_exceeds_capacity() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    let ixn = verify_ixn(MAX_CAPACITY + 1);
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ixn,
        account_metas,
    )
    .await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_sequential_deductions() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // First deduction: 600
    let ixn1 = verify_ixn(600);
    let account_metas1 =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn1.clone()).await;
    process_verify_via_mailbox(&mut banks_client, &payer, ixn1, account_metas1)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, 400);

    // Second deduction: 400 (empties remaining capacity)
    let recent_blockhash2 = banks_client.get_latest_blockhash().await.unwrap();
    let ixn2 = verify_ixn(400);
    let account_metas2 =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash2, ixn2.clone()).await;
    process_verify_via_mailbox(&mut banks_client, &payer, ixn2, account_metas2)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, 0);

    // Any further amount now fails
    let recent_blockhash3 = banks_client.get_latest_blockhash().await.unwrap();
    let ixn3 = verify_ixn(1);
    let account_metas3 =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash3, ixn3.clone()).await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash3,
        ixn3,
        account_metas3,
    )
    .await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_partial_refill() {
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.insecure_clone();

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut ctx.banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // Advance to slot 2 and pin clock to 0 so last_updated is deterministic.
    ctx.warp_to_slot(2).unwrap();
    ctx.set_sysvar(&clock_at(0));

    // Drain full capacity.
    let ixn = verify_ixn(MAX_CAPACITY);
    let account_metas = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn, account_metas)
        .await
        .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level, 0);
    assert_eq!(last_updated, 0);

    // Advance to slot 3 and set clock to half a day (43200 s).
    // refill = 43200 * 1000 / 86400 = 500 tokens.
    ctx.warp_to_slot(3).unwrap();
    ctx.set_sysvar(&clock_at(43200));

    // Verify exactly 500 — should succeed (refill == amount).
    let ixn2 = verify_ixn(500);
    let account_metas2 = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn2.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn2, account_metas2)
        .await
        .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level, 0);
    assert_eq!(last_updated, 43200);

    // Any further amount at the same clock should fail — capacity exhausted.
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let ixn3 = verify_ixn(1);
    let account_metas3 =
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn3.clone()).await;
    let result = simulate_verify(&mut ctx.banks_client, &payer, bh, ixn3, account_metas3).await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_full_reset_after_24h() {
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.insecure_clone();

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut ctx.banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // Advance to slot 2 and pin clock at 0 so last_updated is deterministic.
    ctx.warp_to_slot(2).unwrap();
    ctx.set_sysvar(&clock_at(0));

    // Drain full capacity.
    let ixn = verify_ixn(MAX_CAPACITY);
    let account_metas = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn, account_metas)
        .await
        .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level, 0);
    assert_eq!(last_updated, 0);

    // Advance to slot 3 and set clock past full 24-hour window → full capacity restored.
    ctx.warp_to_slot(3).unwrap();
    ctx.set_sysvar(&clock_at(86_401));

    let ixn2 = verify_ixn(MAX_CAPACITY);
    let account_metas2 = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn2.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn2, account_metas2)
        .await
        .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level, 0);
    assert_eq!(last_updated, 86_401);

    // Capacity exhausted again — any further verify fails.
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let ixn3 = verify_ixn(1);
    let account_metas3 =
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn3.clone()).await;
    let result = simulate_verify(&mut ctx.banks_client, &payer, bh, ixn3, account_metas3).await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_wrong_recipient() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let configured_recipient = H256::from([1u8; 32]);
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::RateLimited {
            max_capacity: MAX_CAPACITY,
            recipient: Some(configured_recipient),
            filled_level: 0,
            last_updated: 0,
            mailbox: mock_mailbox_id(),
        },
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(1);
    msg.recipient = H256::from([2u8; 32]); // different from configured_recipient
    let ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ixn,
        account_metas,
    )
    .await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RecipientMismatch as u32),
        ),
    );
}

#[tokio::test]
async fn test_initialize_no_recipient_rejected() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let node = IsmNode::RateLimited {
        max_capacity: MAX_CAPACITY,
        recipient: None,
        filled_level: 0,
        last_updated: 0,
        mailbox: mock_mailbox_id(),
    };
    let result = initialize(&mut banks_client, &payer, recent_blockhash, node).await;
    assert!(
        result.is_err(),
        "Initialize with recipient: None should be rejected"
    );
}

#[tokio::test]
async fn test_initialize_zero_recipient_rejected() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let node = IsmNode::RateLimited {
        max_capacity: MAX_CAPACITY,
        recipient: Some(H256::zero()),
        filled_level: 0,
        last_updated: 0,
        mailbox: mock_mailbox_id(),
    };
    let result = initialize(&mut banks_client, &payer, recent_blockhash, node).await;
    assert!(
        result.is_err(),
        "Initialize with recipient: Some(zero) should be rejected"
    );
}

#[tokio::test]
async fn test_verify_body_too_short() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // dummy_message has body = vec![] (len 0 < 64)
    let mut msg = dummy_message();
    msg.recipient = WARP_ROUTE;
    let ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ixn,
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
async fn test_verify_amount_overflow() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // body[32..56] non-zero → amount exceeds u64::MAX
    let mut body = vec![0u8; 64];
    body[32] = 1; // high byte of the 32-byte amount field
    let mut msg = dummy_message();
    msg.recipient = WARP_ROUTE;
    msg.body = body;
    let ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        recent_blockhash,
        ixn,
        account_metas,
    )
    .await;

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RateLimitExceeded as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_account_metas_writable_pda() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    let ixn = verify_ixn(1);
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn).await;

    use hyperlane_sealevel_composite_ism::accounts::derive_process_authority;
    let expected_process_authority =
        derive_process_authority(&mock_mailbox_id(), &composite_ism_id()).0;

    // Storage PDA must be writable so the rate limit state can be written back on Verify.
    // Process authority PDA must also be present as a signer.
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert!(account_metas[0].is_writable);
    assert!(!account_metas[0].is_signer);
    assert_eq!(account_metas[1].pubkey, expected_process_authority);
    assert!(account_metas[1].is_signer);
    assert!(!account_metas[1].is_writable);
}

#[tokio::test]
async fn test_update_config_resets_state() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    // Partially drain the capacity.
    let ixn = verify_ixn(500);
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, ixn.clone()).await;
    process_verify_via_mailbox(&mut banks_client, &payer, ixn, account_metas)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, 500);

    // Update config with a new max_capacity — state must reset to new maximum.
    let new_max = 2_000u64;
    let recent_blockhash2 = banks_client.get_latest_blockhash().await.unwrap();
    update_config(
        &mut banks_client,
        &payer,
        recent_blockhash2,
        rate_limited_node(new_max),
    )
    .await
    .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, new_max);
    assert_eq!(last_updated, 0);
}

// ── Regression: zero-amount messages must not update state ───────────────────
//
// A zero-amount message passes the capacity check (0 <= filled_level) but
// must NOT update last_updated or filled_level.  Without the guard, every
// accepted zero-amount message resets the refill timer while consuming no
// capacity — on low-capacity routes this defers the 24-hour full reset
// indefinitely, blocking legitimate non-zero transfers.

#[tokio::test]
async fn test_verify_zero_amount_does_not_update_state() {
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.insecure_clone();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut ctx.banks_client,
        &payer,
        bh,
        rate_limited_node(MAX_CAPACITY),
    )
    .await
    .unwrap();

    ctx.warp_to_slot(2).unwrap();
    ctx.set_sysvar(&clock_at(0));

    // Drain full capacity.
    let ixn = verify_ixn(MAX_CAPACITY);
    let metas = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn, metas)
        .await
        .unwrap();

    let (filled_level, last_updated) = read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level, 0);
    assert_eq!(last_updated, 0);

    // Advance clock to 1 second and send a zero-amount message.
    ctx.warp_to_slot(3).unwrap();
    ctx.set_sysvar(&clock_at(1));

    let ixn_zero = verify_ixn(0);
    let metas_zero = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn_zero.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn_zero, metas_zero)
        .await
        .unwrap();

    // State must be unchanged: last_updated still 0, not advanced to 1.
    // Without the fix it would have been updated to 1, deferring the refill timer.
    let (filled_level_after, last_updated_after) =
        read_rate_limited_state(&mut ctx.banks_client).await;
    assert_eq!(filled_level_after, 0);
    assert_eq!(
        last_updated_after, 0,
        "zero-amount must not update last_updated"
    );
}

#[tokio::test]
async fn test_verify_zero_amount_does_not_defer_refill() {
    // Low-capacity route: max_capacity = 1 means partial refill is always 0
    // (integer division: elapsed * 1 / 86400 = 0 unless elapsed >= 86400).
    // Only the full-window reset at >= 86400 s restores capacity.
    //
    // Bug scenario: zero-amount messages at T=43200 reset last_updated to 43200.
    // A non-zero message at T=86401 then sees elapsed = 43201 < 86400 → no reset → fails.
    //
    // After fix: last_updated stays at 0; elapsed at T=86401 is 86401 >= 86400 → full reset → succeeds.
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.insecure_clone();

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    initialize(&mut ctx.banks_client, &payer, bh, rate_limited_node(1))
        .await
        .unwrap();

    ctx.warp_to_slot(2).unwrap();
    ctx.set_sysvar(&clock_at(0));

    // Drain the single unit of capacity.
    let ixn = verify_ixn(1);
    let metas = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn, metas)
        .await
        .unwrap();

    // At 12 hours: send a zero-amount message.
    // Without fix: last_updated → 43200; elapsed at 86401 would be only 43201 < 86400.
    // With fix: last_updated stays 0; elapsed at 86401 is 86401 >= 86400 (full reset).
    ctx.warp_to_slot(3).unwrap();
    ctx.set_sysvar(&clock_at(43200));

    let ixn_zero = verify_ixn(0);
    let metas_zero = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn_zero.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn_zero, metas_zero)
        .await
        .unwrap();

    // At 24 h + 1 s: the non-zero transfer must succeed (full reset from T0=0).
    ctx.warp_to_slot(4).unwrap();
    ctx.set_sysvar(&clock_at(86_401));

    let ixn_real = verify_ixn(1);
    let metas_real = {
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        get_verify_account_metas(&mut ctx.banks_client, &payer, bh, ixn_real.clone()).await
    };
    process_verify_via_mailbox(&mut ctx.banks_client, &payer, ixn_real, metas_real)
        .await
        .unwrap();
}
