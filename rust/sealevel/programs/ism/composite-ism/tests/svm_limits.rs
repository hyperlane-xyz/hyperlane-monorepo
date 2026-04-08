//! Tests for Solana mainnet resource limits using LiteSVM.
//!
//! Two categories:
//!
//! **Tx size** — `bincode::serialized_size` assertions confirm our wire format stays
//! within the 1232-byte UDP packet limit.  LiteSVM does NOT enforce this limit
//! (it skips the TPU sanitize path), so these are pure arithmetic checks.
//!
//! **Compute Units (CU)** — LiteSVM runs real SBF bytecode and reports exact CU
//! consumption per transaction.  Every instruction must stay under the Solana
//! default of 200 000 CUs to work without a `SetComputeUnitLimit` override.
//! If an instruction legitimately needs more, the test documents that value.
//!
//! These tests require the compiled program at:
//!   `rust/sealevel/target/deploy/hyperlane_sealevel_composite_ism.so`
//! Build with: `cargo build-sbf` from `rust/sealevel/`
//!
//! Run with:
//!   cargo test --test svm_limits -- --include-ignored

mod common;

use std::path::PathBuf;

use hyperlane_core::{Encode, HyperlaneMessage, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::IsmNode,
    instruction::{
        abort_config_update_instruction, begin_config_update_instruction,
        commit_config_update_instruction, initialize_instruction, update_config_instruction,
        write_config_chunk_instruction,
    },
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use litesvm::LiteSVM;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_sdk::{
    hash::Hash,
    message::Message,
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

use common::{composite_ism_id, routing_n_multisig_domains_helper, routing_n_test_domains_helper};

// ── Constants ────────────────────────────────────────────────────────────────

/// Default per-instruction CU budget on mainnet.
const DEFAULT_CU_LIMIT: u64 = 200_000;

/// Solana tx wire-size limit (mirrors `PACKET_DATA_SIZE`).
const TX_SIZE_LIMIT: usize = 1_232;

// ── SVM setup ────────────────────────────────────────────────────────────────

fn program_so_path() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // CARGO_MANIFEST_DIR = rust/sealevel/programs/ism/composite-ism
    // go up 3 levels → rust/sealevel
    let so = manifest_dir.join("../../../target/deploy/hyperlane_sealevel_composite_ism.so");
    let so = so.canonicalize().ok()?;
    if so.exists() {
        Some(so)
    } else {
        None
    }
}

/// Loads the compiled `.so` into a fresh LiteSVM instance.
/// Returns `None` if the binary hasn't been built yet.
fn make_svm() -> Option<LiteSVM> {
    let bytes = std::fs::read(program_so_path()?).ok()?;
    let mut svm = LiteSVM::new();
    svm.add_program(composite_ism_id(), &bytes).ok()?;
    Some(svm)
}

fn funded_payer(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();
    kp
}

// ── Sync instruction helpers ──────────────────────────────────────────────────

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> u64 {
    let bh = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], bh);
    svm.send_transaction(tx)
        .unwrap_or_else(|e| panic!("tx failed: {:?}\nlogs: {:#?}", e.err, e.meta.logs))
        .compute_units_consumed
}

fn do_initialize(svm: &mut LiteSVM, payer: &Keypair, root: IsmNode) {
    let ix = initialize_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    send(svm, payer, ix);
}

fn do_update_config(svm: &mut LiteSVM, payer: &Keypair, root: IsmNode) {
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    send(svm, payer, ix);
}

/// Runs Begin + N×Write + Commit and returns the CU consumed by CommitConfigUpdate.
fn do_chunked_update_return_commit_cu(
    svm: &mut LiteSVM,
    payer: &Keypair,
    root: IsmNode,
    chunk_size: usize,
) -> u64 {
    let bytes = borsh::to_vec(&root).unwrap();
    let total_len = bytes.len() as u32;

    let begin_ix =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), total_len).unwrap();
    send(svm, payer, begin_ix);

    let mut offset = 0u32;
    for chunk in bytes.chunks(chunk_size) {
        let write_ix = write_config_chunk_instruction(
            composite_ism_id(),
            payer.pubkey(),
            offset,
            chunk.to_vec(),
        )
        .unwrap();
        send(svm, payer, write_ix);
        offset += chunk.len() as u32;
    }

    let commit_ix = commit_config_update_instruction(composite_ism_id(), payer.pubkey()).unwrap();
    send(svm, payer, commit_ix)
}

fn storage_pda() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &composite_ism_id()).0
}

fn dummy_message() -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1,
        sender: H256::zero(),
        destination: 2,
        recipient: H256::zero(),
        body: vec![],
    }
}

/// Sends `VerifyAccountMetas` and returns the extra `AccountMeta`s to pass to `Verify`.
fn get_verify_metas(
    svm: &mut LiteSVM,
    payer: &Keypair,
    verify_ix: &VerifyInstruction,
) -> Vec<AccountMeta> {
    use borsh::BorshDeserialize;
    use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

    let bh = svm.latest_blockhash();
    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_ix.clone())
            .encode()
            .unwrap(),
        vec![AccountMeta::new_readonly(storage_pda(), false)],
    );
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], bh);
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("VerifyAccountMetas failed: {:?}", e.err));

    let raw = meta.return_data.data;
    if raw.is_empty() {
        return vec![];
    }
    let metas: Vec<SerializableAccountMeta> =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(&raw)
            .unwrap()
            .return_data;
    metas.into_iter().map(|m| m.into()).collect()
}

/// Calls `Verify` and returns CUs consumed.
fn do_verify(svm: &mut LiteSVM, payer: &Keypair) -> u64 {
    let vi = VerifyInstruction::new(vec![], dummy_message().to_vec());
    let mut metas = vec![AccountMeta::new_readonly(storage_pda(), false)];
    metas.extend(get_verify_metas(svm, payer, &vi));

    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::Verify(vi)
            .encode()
            .unwrap(),
        metas,
    );
    send(svm, payer, ix)
}

// ── Tx-size helpers (no SVM needed) ──────────────────────────────────────────

fn update_config_tx_size(root: &IsmNode) -> usize {
    let payer = Keypair::new();
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root.clone()).unwrap();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &Hash::default());
    let tx = Transaction::new_unsigned(msg);
    bincode::serialized_size(&tx).unwrap() as usize
}

// ── Macro: skip when .so not present ─────────────────────────────────────────

macro_rules! require_svm {
    ($svm:ident) => {
        let Some(mut $svm) = make_svm() else {
            eprintln!("SKIP: .so not built — run `cargo build-sbf` from rust/sealevel/");
            return;
        };
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tx-size tests (pure arithmetic, no SVM)
// ═════════════════════════════════════════════════════════════════════════════

/// 30 MultisigISM routes exceed the 1232-byte limit — single-tx UpdateConfig won't fit.
#[test]
fn test_tx_size_30_multisig_exceeds_limit() {
    let root = routing_n_multisig_domains_helper(30);
    let size = update_config_tx_size(&root);
    assert!(
        size > TX_SIZE_LIMIT,
        "30-multisig tx should be oversized; got {} bytes",
        size
    );
}

/// 200 Test-domain routes also exceed the limit.
#[test]
fn test_tx_size_200_test_domains_exceeds_limit() {
    let root = routing_n_test_domains_helper(200);
    let size = update_config_tx_size(&root);
    assert!(
        size > TX_SIZE_LIMIT,
        "200-domain tx should be oversized; got {} bytes",
        size
    );
}

/// 150 MultisigISM routes massively exceed the limit (~5700-byte ISM encoding alone).
/// Only reachable via chunked update.
#[test]
fn test_tx_size_150_multisig_exceeds_limit() {
    let root = routing_n_multisig_domains_helper(150);
    let size = update_config_tx_size(&root);
    assert!(
        size > TX_SIZE_LIMIT,
        "150-multisig tx should be oversized; got {} bytes",
        size
    );
}

/// 25 MultisigISM routes fit within the limit — single-tx UpdateConfig is possible.
#[test]
fn test_tx_size_25_multisig_fits_limit() {
    let root = routing_n_multisig_domains_helper(25);
    let size = update_config_tx_size(&root);
    assert!(
        size <= TX_SIZE_LIMIT,
        "25-multisig tx should fit; got {} bytes",
        size
    );
}

/// 150 Test-domain routes fit within the limit (lightweight sub-ISMs).
#[test]
fn test_tx_size_150_test_domains_fits_limit() {
    let root = routing_n_test_domains_helper(150);
    let size = update_config_tx_size(&root);
    assert!(
        size <= TX_SIZE_LIMIT,
        "150-test-domain tx should fit; got {} bytes",
        size
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// CU tests  (#[ignore] — need compiled .so)
// ═════════════════════════════════════════════════════════════════════════════

// ── Initialize ───────────────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_initialize_test_ism() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    let ix = initialize_instruction(
        composite_ism_id(),
        payer.pubkey(),
        IsmNode::Test { accept: true },
    )
    .unwrap();
    let cu = send(&mut svm, &payer, ix);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "Initialize used {} CUs (limit {})",
        cu,
        DEFAULT_CU_LIMIT
    );
    eprintln!("Initialize (Test ISM): {} CUs", cu);
}

// ── UpdateConfig ─────────────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_update_config_test_ism() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let ix = update_config_instruction(
        composite_ism_id(),
        payer.pubkey(),
        IsmNode::Test { accept: true },
    )
    .unwrap();
    let cu = send(&mut svm, &payer, ix);
    assert!(cu < DEFAULT_CU_LIMIT, "UpdateConfig(Test) used {} CUs", cu);
    eprintln!("UpdateConfig (Test ISM): {} CUs", cu);
}

/// Near-limit single-tx update: 25 MultisigISM domains (~1202-byte tx).
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_update_config_25_multisig() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let root = routing_n_multisig_domains_helper(25);
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    let cu = send(&mut svm, &payer, ix);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "UpdateConfig(25-multisig) used {} CUs",
        cu
    );
    eprintln!("UpdateConfig (25-multisig routing): {} CUs", cu);
}

// ── BeginConfigUpdate ────────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_begin_config_update() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let bytes = borsh::to_vec(&routing_n_test_domains_helper(150)).unwrap();
    let ix =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), bytes.len() as u32)
            .unwrap();
    let cu = send(&mut svm, &payer, ix);
    assert!(cu < DEFAULT_CU_LIMIT, "BeginConfigUpdate used {} CUs", cu);
    eprintln!("BeginConfigUpdate: {} CUs", cu);
}

// ── WriteConfigChunk ─────────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_write_config_chunk_small() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    // Begin with a 200-byte buffer, write the first 100 bytes.
    let ix_begin =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), 200).unwrap();
    send(&mut svm, &payer, ix_begin);

    let ix_write =
        write_config_chunk_instruction(composite_ism_id(), payer.pubkey(), 0, vec![0u8; 100])
            .unwrap();
    let cu = send(&mut svm, &payer, ix_write);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "WriteConfigChunk(100B) used {} CUs",
        cu
    );
    eprintln!("WriteConfigChunk (100 bytes): {} CUs", cu);
}

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_write_config_chunk_large() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    // Use a 900-byte chunk — close to the max that fits in a single tx.
    let ix_begin =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), 900).unwrap();
    send(&mut svm, &payer, ix_begin);

    let ix_write =
        write_config_chunk_instruction(composite_ism_id(), payer.pubkey(), 0, vec![0u8; 900])
            .unwrap();
    let cu = send(&mut svm, &payer, ix_write);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "WriteConfigChunk(900B) used {} CUs",
        cu
    );
    eprintln!("WriteConfigChunk (900 bytes): {} CUs", cu);
}

// ── CommitConfigUpdate ───────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_commit_config_update_test_ism() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let cu =
        do_chunked_update_return_commit_cu(&mut svm, &payer, IsmNode::Test { accept: true }, 800);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "CommitConfigUpdate(Test) used {} CUs",
        cu
    );
    eprintln!("CommitConfigUpdate (Test ISM): {} CUs", cu);
}

/// Large config: routing with 150 Test sub-ISMs (~906 bytes Borsh).
/// CommitConfigUpdate must deserialise the full pending blob — highest CU risk.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_commit_config_update_150_test_domains() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let root = routing_n_test_domains_helper(150);
    let cu = do_chunked_update_return_commit_cu(&mut svm, &payer, root, 800);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "CommitConfigUpdate(150-test-domains) used {} CUs — exceeds default limit!",
        cu
    );
    eprintln!(
        "CommitConfigUpdate (150-domain routing, Test sub-ISMs): {} CUs",
        cu
    );
}

/// Large config: routing with 30 MultisigISM sub-ISMs (~1140 bytes Borsh).
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_commit_config_update_30_multisig() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let root = routing_n_multisig_domains_helper(30);
    let cu = do_chunked_update_return_commit_cu(&mut svm, &payer, root, 800);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "CommitConfigUpdate(30-multisig) used {} CUs — exceeds default limit!",
        cu
    );
    eprintln!(
        "CommitConfigUpdate (30-domain routing, MultisigISM sub-ISMs): {} CUs",
        cu
    );
}

/// Largest known-working config: routing with 100 MultisigISM sub-ISMs (~3800 bytes Borsh,
/// 80k CUs).  Borsh deserialization of ≥120 domains exhausts the 32 KB SBF heap.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_commit_config_update_100_multisig() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let root = routing_n_multisig_domains_helper(100);
    let cu = do_chunked_update_return_commit_cu(&mut svm, &payer, root, 800);
    assert!(
        cu < DEFAULT_CU_LIMIT,
        "CommitConfigUpdate(100-multisig) used {} CUs — exceeds default limit!",
        cu
    );
    eprintln!(
        "CommitConfigUpdate (100-domain routing, MultisigISM sub-ISMs): {} CUs",
        cu
    );
}

/// 150 MultisigISM domains exceed the 32 KB SBF heap limit during Borsh
/// deserialisation inside CommitConfigUpdate.  The boundary lies between 100
/// (passes) and 120 (OOM).  This test documents the failure so it is caught
/// if the heap limit changes.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_commit_config_update_150_multisig_exceeds_heap() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let root = routing_n_multisig_domains_helper(150);
    let bytes = borsh::to_vec(&root).unwrap();
    let total = bytes.len() as u32;

    let ix = begin_config_update_instruction(composite_ism_id(), payer.pubkey(), total).unwrap();
    send(&mut svm, &payer, ix);
    let mut offset = 0u32;
    for chunk in bytes.chunks(800) {
        let ix = write_config_chunk_instruction(
            composite_ism_id(),
            payer.pubkey(),
            offset,
            chunk.to_vec(),
        )
        .unwrap();
        send(&mut svm, &payer, ix);
        offset += chunk.len() as u32;
    }

    let ix = commit_config_update_instruction(composite_ism_id(), payer.pubkey()).unwrap();
    let bh = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
    let result = svm.send_transaction(tx);
    assert!(
        result.is_err(),
        "Expected heap OOM for 150-multisig CommitConfigUpdate, but it succeeded"
    );
    let logs = result.unwrap_err().meta.logs;
    assert!(
        logs.iter()
            .any(|l| l.contains("out of memory") || l.contains("memory allocation failed")),
        "Expected OOM log, got: {:?}",
        logs
    );
    eprintln!("150-multisig CommitConfigUpdate correctly fails with heap OOM (32 KB SBF limit)");
}

// ── AbortConfigUpdate ────────────────────────────────────────────────────────

#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_abort_config_update() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let ix_begin =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), 500).unwrap();
    send(&mut svm, &payer, ix_begin);

    let ix_abort = abort_config_update_instruction(composite_ism_id(), payer.pubkey()).unwrap();
    let cu = send(&mut svm, &payer, ix_abort);
    assert!(cu < DEFAULT_CU_LIMIT, "AbortConfigUpdate used {} CUs", cu);
    eprintln!("AbortConfigUpdate: {} CUs", cu);
}

// ── Verify ───────────────────────────────────────────────────────────────────

/// Verify with a simple `Test { accept: true }` ISM.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_verify_test_ism() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let cu = do_verify(&mut svm, &payer);
    assert!(cu < DEFAULT_CU_LIMIT, "Verify(Test) used {} CUs", cu);
    eprintln!("Verify (Test ISM): {} CUs", cu);
}

/// Verify with a routing ISM pointing to 10 Test sub-ISMs.
/// Tests the recursion overhead of routing lookup + sub-ISM dispatch.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_verify_routing_10_test_domains() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);

    // Route domain 1 (origin of dummy_message) to Test { accept: true }.
    let root = routing_n_test_domains_helper(10); // includes domain 1
    do_initialize(&mut svm, &payer, root);

    let cu = do_verify(&mut svm, &payer);
    assert!(cu < DEFAULT_CU_LIMIT, "Verify(routing-10) used {} CUs", cu);
    eprintln!("Verify (routing, 10 Test sub-ISMs): {} CUs", cu);
}

/// GetMetadataSpec (VerifyAccountMetas) for a routing ISM.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_get_metadata_spec_routing() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, routing_n_test_domains_helper(10));

    let vi = VerifyInstruction::new(vec![], dummy_message().to_vec());
    let bh = svm.latest_blockhash();
    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::VerifyAccountMetas(vi)
            .encode()
            .unwrap(),
        vec![AccountMeta::new_readonly(storage_pda(), false)],
    );
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("VerifyAccountMetas failed: {:?}", e.err));
    let cu = meta.compute_units_consumed;
    assert!(cu < DEFAULT_CU_LIMIT, "VerifyAccountMetas used {} CUs", cu);
    eprintln!("VerifyAccountMetas (routing, 10 domains): {} CUs", cu);
}

/// `Type` instruction — should be trivially cheap.
#[test]
#[ignore = "requires compiled .so (cargo build-sbf from rust/sealevel/)"]
fn test_cu_type_instruction() {
    require_svm!(svm);
    let payer = funded_payer(&mut svm);
    do_initialize(&mut svm, &payer, IsmNode::Test { accept: true });

    let bh = svm.latest_blockhash();
    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &InterchainSecurityModuleInstruction::Type.encode().unwrap(),
        vec![AccountMeta::new_readonly(storage_pda(), false)],
    );
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("Type failed: {:?}", e.err));
    let cu = meta.compute_units_consumed;
    assert!(cu < DEFAULT_CU_LIMIT, "Type used {} CUs", cu);
    eprintln!("Type instruction: {} CUs", cu);
}
