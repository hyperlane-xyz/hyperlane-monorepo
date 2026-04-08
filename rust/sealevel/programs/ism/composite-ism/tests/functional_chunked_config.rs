//! Functional tests for the chunked config update instructions.
//!
//! These instructions allow configs too large for a single transaction to be
//! written in multiple transactions:
//!   BeginConfigUpdate(total_len)  — allocates staging buffer, owner-gated
//!   WriteConfigChunk{offset,data} — writes bytes into staging buffer
//!   CommitConfigUpdate            — validates + activates staged config
//!   AbortConfigUpdate             — discards staged config without committing
//!
//! The single-tx UpdateConfig instruction is limited to configs whose
//! serialised IsmNode fits within ~1015 bytes of instruction data (leaving
//! room for tx framing, signatures and account keys in the 1232-byte packet
//! limit). The chunked path has no such restriction.

mod common;

use hyperlane_core::{Encode, H160};
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, DomainConfig, IsmNode},
    error::Error,
    instruction::update_config_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_sdk::{
    hash::Hash, instruction::InstructionError, message::Message, signature::Signer,
    signer::keypair::Keypair, transaction::Transaction, transaction::TransactionError,
};

use common::{
    abort_config_update, assert_simulation_error, assert_simulation_ok, begin_config_update,
    chunked_update_config, commit_config_update, composite_ism_id, dummy_message,
    get_verify_account_metas, initialize, program_test, simulate_verify, storage_pda_key,
    write_config_chunk,
};

/// Tx size limit enforced by the Solana bank (mirrors the UDP packet limit).
/// Source: `solana_packet::PACKET_DATA_SIZE`.
pub const SOLANA_TX_SIZE_LIMIT: usize = 1232;

/// Maximum Borsh-encoded IsmNode bytes that fit in a single UpdateConfig tx.
///
/// This is derived from the real wire size: see `update_config_tx_size`.
/// The overhead of a minimal legacy tx (1 sig, 3 accounts) is ~214 bytes.
const APPROX_MAX_SINGLE_TX_ISM_BYTES: usize = SOLANA_TX_SIZE_LIMIT - 214;

// ── Config-size helpers ──────────────────────────────────────────────────────

/// Routing ISM with `n` domains, each pointing to `Test { accept: true }`.
/// Borsh size per route: 4 (domain u32) + 2 (Test variant + bool) = 6 bytes.
/// Total IsmNode ≈ 1 + 4 + n*6 + 1 bytes.
fn routing_n_test_domains(n: u32) -> IsmNode {
    IsmNode::Routing {
        routes: (1..=n)
            .map(|d| (d, IsmNode::Test { accept: true }))
            .collect(),
        default_ism: None,
    }
}

/// Routing ISM with `n` domains, each pointing to a `MultisigMessageId` with
/// one dummy validator.
/// Borsh size per route: 4 (domain) + 1 (variant) + 4 (vec len) +
///   [4 (origin) + 4 (validators vec len) + 20 (H160) + 1 (threshold)] = 38 bytes.
fn routing_n_multisig_domains(n: u32) -> IsmNode {
    let dummy_validator = H160::from([0xABu8; 20]);
    IsmNode::Routing {
        routes: (1..=n)
            .map(|d| {
                (
                    d,
                    IsmNode::MultisigMessageId {
                        domain_configs: vec![DomainConfig {
                            origin: d,
                            validators: vec![dummy_validator],
                            threshold: 1,
                        }],
                    },
                )
            })
            .collect(),
        default_ism: None,
    }
}

/// Returns the exact wire size (bytes) of an UpdateConfig transaction for the
/// given root, using `bincode` (the same serializer Solana uses on-chain).
pub fn update_config_tx_size(root: &IsmNode) -> usize {
    let payer = Keypair::new();
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root.clone()).unwrap();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &Hash::default());
    let tx = Transaction::new_unsigned(msg);
    bincode::serialized_size(&tx).unwrap() as usize
}

// ── Single-tx limit demonstration ────────────────────────────────────────────

/// A routing ISM with 150 Test sub-ISMs has an IsmNode Borsh encoding of ~906
/// bytes, which fits within a single UpdateConfig tx. This is the largest
/// Test-domain config that the user explicitly asked to support.
#[test]
fn test_routing_150_test_domains_fits_single_tx() {
    let root = routing_n_test_domains(150);
    let ism_bytes = borsh::to_vec(&root).unwrap();
    assert!(
        ism_bytes.len() <= APPROX_MAX_SINGLE_TX_ISM_BYTES,
        "150 Test-domain routing ISM ({} bytes) should fit in single tx",
        ism_bytes.len()
    );
}

/// A routing ISM with 30 MultisigISM sub-ISMs (~1146 bytes IsmNode) exceeds
/// the single-tx limit, making it impossible to set via a plain UpdateConfig.
#[test]
fn test_routing_30_multisig_domains_exceeds_single_tx() {
    let root = routing_n_multisig_domains(30);
    let tx_size = update_config_tx_size(&root);
    assert!(
        tx_size > SOLANA_TX_SIZE_LIMIT,
        "30 MultisigISM-domain routing ISM tx ({} bytes) should exceed the {} byte limit",
        tx_size,
        SOLANA_TX_SIZE_LIMIT
    );
}

/// A routing ISM with 200 Test sub-ISMs (~1206 bytes IsmNode) also exceeds
/// the single-tx limit.
#[test]
fn test_routing_200_test_domains_exceeds_single_tx() {
    let root = routing_n_test_domains(200);
    let tx_size = update_config_tx_size(&root);
    assert!(
        tx_size > SOLANA_TX_SIZE_LIMIT,
        "200 Test-domain routing ISM tx ({} bytes) should exceed the {} byte limit",
        tx_size,
        SOLANA_TX_SIZE_LIMIT
    );
}

// ── Basic chunked update correctness ─────────────────────────────────────────

#[tokio::test]
async fn test_begin_allocates_pending_buffer() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 64)
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

    let pending = storage
        .pending_config
        .expect("pending_config should be Some");
    assert_eq!(pending.total_len, 64);
    assert_eq!(pending.bytes.len(), 64);
    assert!(
        pending.bytes.iter().all(|&b| b == 0),
        "buffer should be zeroed"
    );
    // Old root is untouched.
    assert_eq!(storage.root, Some(IsmNode::Test { accept: false }));
}

#[tokio::test]
async fn test_write_and_commit_single_chunk() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    let new_root = IsmNode::Test { accept: true };
    let bytes = borsh::to_vec(&new_root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, bytes)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    commit_config_update(&mut banks_client, &payer, blockhash)
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

    assert_eq!(storage.root, Some(new_root));
    assert!(
        storage.pending_config.is_none(),
        "pending should be cleared after commit"
    );
}

#[tokio::test]
async fn test_write_multi_chunk_and_commit() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // Use a 10-domain routing ISM whose bytes are split into 3 chunks.
    let new_root = routing_n_test_domains(10);
    let bytes = borsh::to_vec(&new_root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
        .await
        .unwrap();

    // Write in 3 chunks of roughly equal size.
    let chunk_size = (bytes.len() / 3).max(1);
    let mut offset = 0u32;
    for chunk in bytes.chunks(chunk_size) {
        let blockhash = banks_client.get_latest_blockhash().await.unwrap();
        write_config_chunk(&mut banks_client, &payer, blockhash, offset, chunk.to_vec())
            .await
            .unwrap();
        offset += chunk.len() as u32;
    }

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    commit_config_update(&mut banks_client, &payer, blockhash)
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

    assert_eq!(storage.root, Some(new_root));
    assert!(storage.pending_config.is_none());
}

// ── Big configs that previously required chunking ────────────────────────────

/// 150-domain routing ISM with Test sub-ISMs: fits in a single UpdateConfig tx
/// (~906 bytes IsmNode), but we also verify the chunked path works correctly
/// and that Verify selects the right sub-ISM after commit.
#[tokio::test]
async fn test_150_test_domains_via_chunked_update_and_verify() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    let root = routing_n_test_domains(150);
    // Use 800-byte chunks — well within the single-tx limit.
    chunked_update_config(&mut banks_client, &payer, root.clone(), 800).await;

    // Verify that all 150 routes were stored correctly.
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

    // Verify works for a message with origin = domain 75 (middle of the list).
    let mut msg = dummy_message();
    msg.origin = 75;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

/// 30-domain routing ISM with MultisigISM sub-ISMs: exceeds the single-tx
/// limit (~1360 bytes estimated tx), so UpdateConfig would be rejected on
/// mainnet. Chunked update makes it possible.
#[tokio::test]
async fn test_30_multisig_domains_only_possible_via_chunked_update() {
    let root = routing_n_multisig_domains(30);

    // Confirm this config cannot fit in a single UpdateConfig tx.
    let tx_size = update_config_tx_size(&root);
    assert!(
        tx_size > SOLANA_TX_SIZE_LIMIT,
        "pre-condition: 30-multisig-domain config ({} bytes) must exceed tx limit",
        tx_size
    );

    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    chunked_update_config(&mut banks_client, &payer, root.clone(), 800).await;

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

/// 200-domain routing ISM with Test sub-ISMs: also exceeds the single-tx limit
/// (~1418 bytes serialized tx). Verifies Verify reaches the last domain.
#[tokio::test]
async fn test_200_test_domains_only_possible_via_chunked_update() {
    let root = routing_n_test_domains(200);

    let tx_size = update_config_tx_size(&root);
    assert!(
        tx_size > SOLANA_TX_SIZE_LIMIT,
        "pre-condition: 200-domain config ({} bytes) must exceed tx limit",
        tx_size
    );

    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    chunked_update_config(&mut banks_client, &payer, root.clone(), 800).await;

    // Verify reaches the last domain (domain 200) — worst-case O(N) scan.
    let mut msg = dummy_message();
    msg.origin = 200;
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

// ── Abort ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_abort_clears_pending_and_preserves_old_root() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    let original = IsmNode::Test { accept: true };
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        original.clone(),
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 100)
        .await
        .unwrap();

    // Abort mid-update.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    abort_config_update(&mut banks_client, &payer, blockhash)
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

    assert_eq!(storage.root, Some(original));
    assert!(storage.pending_config.is_none());
}

#[tokio::test]
async fn test_abort_when_no_pending_is_noop() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // AbortConfigUpdate with no pending — should succeed silently.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    abort_config_update(&mut banks_client, &payer, blockhash)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_begin_resets_existing_pending() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // First begin with size 100.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 100)
        .await
        .unwrap();

    // Write a chunk so the buffer has non-zero content.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, vec![0xFFu8; 10])
        .await
        .unwrap();

    // Second begin with a different size — should reset the buffer.
    let new_root = IsmNode::Pausable { paused: false };
    let bytes = borsh::to_vec(&new_root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
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

    let pending = storage.pending_config.unwrap();
    assert_eq!(pending.total_len, total_len);
    assert_eq!(pending.bytes.len(), total_len as usize);
    // Ensure buffer is zeroed (previous bytes not carried over).
    assert!(pending.bytes.iter().all(|&b| b == 0));
}

// ── Verify uses old root while update is in progress ─────────────────────────

#[tokio::test]
async fn test_verify_uses_old_root_during_pending_update() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // Start a chunked update that would replace the root with accept=false.
    let new_root = IsmNode::Test { accept: false };
    let bytes = borsh::to_vec(&new_root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
        .await
        .unwrap();

    // Write the bytes but DO NOT commit yet.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, bytes)
        .await
        .unwrap();

    // Verify should still use the old root (accept=true).
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: dummy_message().to_vec(),
    };
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;
    assert_simulation_ok(&result);
}

#[tokio::test]
async fn test_verify_uses_new_root_after_commit() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // Chunked update to accept=false.
    chunked_update_config(
        &mut banks_client,
        &payer,
        IsmNode::Test { accept: false },
        800,
    )
    .await;

    // Verify should now reject.
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: dummy_message().to_vec(),
    };
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
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

// ── Error cases ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_write_chunk_without_begin_fails() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let err = write_config_chunk(&mut banks_client, &payer, blockhash, 0, vec![0u8; 4])
        .await
        .unwrap_err();

    // BanksClientError wraps the TransactionError.
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains(&(Error::NoPendingUpdate as u32).to_string()),
        "expected NoPendingUpdate error, got: {}",
        err_str
    );
}

#[tokio::test]
async fn test_commit_without_begin_fails() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let err = commit_config_update(&mut banks_client, &payer, blockhash)
        .await
        .unwrap_err();

    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains(&(Error::NoPendingUpdate as u32).to_string()),
        "expected NoPendingUpdate error, got: {}",
        err_str
    );
}

#[tokio::test]
async fn test_write_chunk_out_of_bounds_fails() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 10)
        .await
        .unwrap();

    // Attempt to write 5 bytes starting at offset 8 → end=13 > total_len=10.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let err = write_config_chunk(&mut banks_client, &payer, blockhash, 8, vec![0u8; 5])
        .await
        .unwrap_err();

    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains(&(Error::ChunkOutOfBounds as u32).to_string()),
        "expected ChunkOutOfBounds error, got: {}",
        err_str
    );
}

#[tokio::test]
async fn test_commit_invalid_borsh_fails() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 8)
        .await
        .unwrap();

    // Write garbage bytes that cannot be Borsh-decoded as IsmNode.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, vec![0xFFu8; 8])
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let err = commit_config_update(&mut banks_client, &payer, blockhash)
        .await
        .unwrap_err();

    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains(&(Error::InvalidConfig as u32).to_string()),
        "expected InvalidConfig error, got: {}",
        err_str
    );
}

#[tokio::test]
async fn test_commit_validates_config_on_commit() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // Aggregation with threshold=3 but only 1 sub-ISM → invalid config.
    let invalid_root = IsmNode::Aggregation {
        threshold: 3,
        sub_isms: vec![IsmNode::Test { accept: true }],
    };
    let bytes = borsh::to_vec(&invalid_root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, bytes)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let err = commit_config_update(&mut banks_client, &payer, blockhash)
        .await
        .unwrap_err();

    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains(&(Error::InvalidConfig as u32).to_string()),
        "expected InvalidConfig error, got: {}",
        err_str
    );
}

#[tokio::test]
async fn test_commit_normalizes_rate_limited_state() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    // RateLimited with caller-supplied state values — they should be normalised
    // by CommitConfigUpdate.
    let root = IsmNode::RateLimited {
        max_capacity: 1_000,
        recipient: None,
        filled_level: 0,     // should be normalised to max_capacity
        last_updated: 99999, // should be normalised to 0
    };
    let bytes = borsh::to_vec(&root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, total_len)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, bytes)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    commit_config_update(&mut banks_client, &payer, blockhash)
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

    assert_eq!(
        storage.root,
        Some(IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 1_000,
            last_updated: 0,
        })
    );
}

/// Overlapping chunk writes: last write wins. Write [0..10] with 0xAA, then
/// overwrite [5..15] with 0xBB — bytes [5..10] should be 0xBB.
#[tokio::test]
async fn test_overlapping_writes_last_wins() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: false },
    )
    .await
    .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(&mut banks_client, &payer, blockhash, 20)
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 0, vec![0xAAu8; 10])
        .await
        .unwrap();

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    write_config_chunk(&mut banks_client, &payer, blockhash, 5, vec![0xBBu8; 10])
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
    let bytes = &storage.pending_config.unwrap().bytes;

    assert_eq!(&bytes[0..5], &[0xAAu8; 5]);
    assert_eq!(&bytes[5..15], &[0xBBu8; 10]);
    assert_eq!(&bytes[15..20], &[0x00u8; 5]);
}
