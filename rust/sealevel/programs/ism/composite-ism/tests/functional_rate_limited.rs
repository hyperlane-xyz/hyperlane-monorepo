//! Functional tests for the RateLimited ISM node type.
//!
//! Enforces a rolling 24-hour transfer limit on token amounts in messages.
//! State (filled_level, last_updated) is stored inline in the VAM PDA.
//!
//! CONFIG:
//! - Initialize normalizes filled_level to max_capacity and last_updated to 0
//! - Type returns ModuleType::Null
//!
//! VERIFY:
//! - Verify succeeds and decrements filled_level when amount is within capacity
//! - Verify succeeds when amount equals the full remaining capacity
//! - Verify fails with RateLimitExceeded when amount exceeds available capacity
//! - Sequential verifies track remaining capacity correctly
//! - After a partial time elapsed, partial refill allows additional transfers
//! - After a full 24-hour window, capacity is fully restored
//! - Verify fails with RecipientMismatch when recipient does not match the configured one
//! - Verify succeeds for any recipient when no recipient is configured
//! - Verify fails with InvalidMessageBody when message body is shorter than 64 bytes
//! - Verify fails with InvalidMessageBody when message amount overflows u64 (high bytes non-zero)
//! - VerifyAccountMetas returns the storage PDA as writable (state is mutated on Verify)
//! - UpdateConfig resets rate limit state to full capacity

mod common;

use borsh::BorshDeserialize;
use hyperlane_core::{Encode, ModuleType, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
    instruction::update_config_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use solana_program::instruction::AccountMeta;
use solana_program_test::{BanksClient, BanksClientError, ProgramTestContext};
use solana_sdk::{
    clock::Clock,
    hash::Hash,
    instruction::{Instruction, InstructionError},
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use common::{
    assert_simulation_error, assert_simulation_ok, composite_ism_id, dummy_message, get_ism_type,
    get_verify_account_metas, initialize, program_test, simulate_verify, storage_pda_key,
    token_message_body,
};

const MAX_CAPACITY: u64 = 1_000;

fn rate_limited_node(max_capacity: u64) -> IsmNode {
    IsmNode::RateLimited {
        max_capacity,
        recipient: None,
        filled_level: 0, // normalized to max_capacity on initialize
        last_updated: 0,
    }
}

fn verify_ixn(amount: u64) -> VerifyInstruction {
    let mut msg = dummy_message();
    msg.body = token_message_body(amount);
    VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    }
}

async fn process_verify_with_banks(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    ixn: VerifyInstruction,
    account_metas: Vec<AccountMeta>,
) -> Result<(), BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::Verify(ixn)
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

#[tokio::test]
async fn test_ism_type() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY),
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
    process_verify_with_banks(&mut banks_client, &payer, ixn, account_metas)
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
    process_verify_with_banks(&mut banks_client, &payer, ixn, account_metas)
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
    process_verify_with_banks(&mut banks_client, &payer, ixn1, account_metas1)
        .await
        .unwrap();

    let (filled_level, _) = read_rate_limited_state(&mut banks_client).await;
    assert_eq!(filled_level, 400);

    // Second deduction: 400 (empties remaining capacity)
    let recent_blockhash2 = banks_client.get_latest_blockhash().await.unwrap();
    let ixn2 = verify_ixn(400);
    let account_metas2 =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash2, ixn2.clone()).await;
    process_verify_with_banks(&mut banks_client, &payer, ixn2, account_metas2)
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
    process_verify_with_banks(&mut ctx.banks_client, &payer, ixn, account_metas)
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
    process_verify_with_banks(&mut ctx.banks_client, &payer, ixn2, account_metas2)
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
    process_verify_with_banks(&mut ctx.banks_client, &payer, ixn, account_metas)
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
    process_verify_with_banks(&mut ctx.banks_client, &payer, ixn2, account_metas2)
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
async fn test_verify_any_recipient_when_none() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        rate_limited_node(MAX_CAPACITY), // recipient: None
    )
    .await
    .unwrap();

    let mut msg = dummy_message();
    msg.body = token_message_body(1);
    msg.recipient = H256::from([0xAB; 32]); // arbitrary recipient
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

    assert_simulation_ok(&result);
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
    let msg = dummy_message();
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
            InstructionError::Custom(Error::InvalidMessageBody as u32),
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

    // Storage PDA must be writable so the rate limit state can be written back on Verify.
    assert_eq!(account_metas.len(), 1);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert!(account_metas[0].is_writable);
    assert!(!account_metas[0].is_signer);
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
    process_verify_with_banks(&mut banks_client, &payer, ixn, account_metas)
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
