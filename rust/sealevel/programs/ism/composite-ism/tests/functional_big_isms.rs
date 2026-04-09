//! Scale tests for the composite ISM — validates behaviour under production-scale
//! configs using the **compiled BPF binary** so that real Solana constraints are
//! enforced: 32 KB heap, 4 KB stack frame, 1.4 M CU compute budget.
//!
//! Before running, rebuild the binary if you have changed the program source:
//!
//! ```text
//! cargo build-sbf --manifest-path programs/ism/composite-ism/Cargo.toml
//! ```
//! (run from `rust/sealevel/`)
//!
//! TESTS:
//! - 200 domains, each Routing → Aggregation(2-of-2)[Pausable, MultisigMessageId(7v,3)]
//! - 16 levels of nested single-child Aggregation (call-depth + stack)
//! - UpdateConfig realloc: grow storage PDA from Test to Aggregation(50-of-50)
//! - Wide Aggregation: 50-of-50 Test sub-ISMs (heap + compute scaling with fan-out)
//! - Multisig compute budget: 3× MultisigMessageId(3v,3) = 9 secp256k1 recoveries
//! - Metadata tx size: 3×3 Aggregation of MultisigMessageId produces >1232-byte metadata
//! - SetDomainIsm with large domain ISM: Aggregation(2-of-2)[MultisigMessageId(7v,3) ×2]

mod common;

use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, H160, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::IsmNode, multisig_metadata::MultisigIsmMessageIdMetadata,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use solana_program_test::ProgramTest;
use solana_sdk::signature::Signer;
use std::str::FromStr;

use common::{
    assert_simulation_ok, composite_ism_id, encode_aggregation_metadata,
    get_all_verify_account_metas, get_verify_account_metas, initialize, set_domain_ism,
    simulate_verify, storage_pda_key, update_config,
};

// ---------------------------------------------------------------------------
// BPF program loader
// ---------------------------------------------------------------------------

/// Returns a `ProgramTest` that loads the **compiled BPF binary** from
/// `target/deploy/` instead of running the native Rust processor.
///
/// This is the only way to exercise real BPF constraints:
///   - 32 KB heap (enforced by the SBF VM)
///   - 4 KB stack frame limit (checked by the linker)
///   - Accurate compute-unit metering (including secp256k1 syscall cost)
///
/// The binary is found via the `SBF_OUT_DIR` environment variable, which
/// this function sets to `<workspace>/target/deploy/` before constructing
/// the `ProgramTest`.  Setting a global env var is acceptable here because
/// the scale test runs as its own process (separate integration-test binary).
fn bpf_program_test() -> ProgramTest {
    let deploy_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/deploy")
        .canonicalize()
        .unwrap_or_else(|_| {
            panic!("target/deploy/ not found — run `cargo build-sbf` from rust/sealevel/ first")
        });
    std::env::set_var("SBF_OUT_DIR", &deploy_dir);
    let mut pt = ProgramTest::new(
        "hyperlane_sealevel_composite_ism",
        composite_ism_id(),
        None, // None = load BPF binary; do NOT pass processor!() here
    );
    // Allow the full Solana mainnet compute budget so scale tests that do many
    // secp256k1 recoveries are not artificially capped at the 200k default.
    pt.set_compute_max_units(1_400_000);
    pt
}

/// The domain used for the actual `Verify` call.  Must equal the
/// `mailbox_domain` baked into the hardcoded ECDSA test signatures below.
const VERIFY_DOMAIN: u32 = 1234;

/// Total number of domain PDAs to configure.
const TOTAL_DOMAINS: usize = 200;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/// Seven validators.  The first three (indices 0-2) have known private keys
/// with corresponding test signatures.  Validators 3-6 are filler addresses
/// with no signatures — 3-of-7 threshold is satisfied by validators 0-2.
fn seven_validators() -> Vec<H160> {
    vec![
        H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
        H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
        H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
        // Fillers — no corresponding signatures.
        H160::from_str("0x1111111111111111111111111111111111111111").unwrap(),
        H160::from_str("0x2222222222222222222222222222222222222222").unwrap(),
        H160::from_str("0x3333333333333333333333333333333333333333").unwrap(),
        H160::from_str("0x4444444444444444444444444444444444444444").unwrap(),
    ]
}

/// First three of the seven validators (those with known ECDSA fixtures).
fn three_validators() -> Vec<H160> {
    seven_validators().into_iter().take(3).collect()
}

/// Three valid ECDSA signatures for the checkpoint defined in
/// `build_aggregation_metadata`, signed by validators 0, 1, and 2 respectively.
/// These are the same fixtures used across the other multisig functional tests.
fn three_valid_sigs() -> Vec<Vec<u8>> {
    vec![
        hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap(),
        hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap(),
        hex::decode("5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b").unwrap(),
    ]
}

fn scale_message() -> hyperlane_core::HyperlaneMessage {
    hyperlane_core::HyperlaneMessage {
        version: 3,
        nonce: 69,
        origin: VERIFY_DOMAIN,
        sender: H256::from_str(
            "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
        )
        .unwrap(),
        destination: 4321,
        recipient: H256::from_str(
            "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
        )
        .unwrap(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }
}

/// Builds aggregation metadata for [Pausable (empty), MultisigMessageId (3 sigs)].
fn build_aggregation_metadata(message: &hyperlane_core::HyperlaneMessage) -> Vec<u8> {
    let checkpoint = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: VERIFY_DOMAIN,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: message.nonce + 1,
        },
        message_id: message.id(),
    };
    let sigs = three_valid_sigs();
    let multisig_meta = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: sigs
            .iter()
            .map(|s| EcdsaSignature::from_bytes(s).unwrap())
            .collect(),
    }
    .to_vec();

    // sub-ISM 0 = Pausable (empty metadata), sub-ISM 1 = MultisigMessageId
    encode_aggregation_metadata(&[Some(&[]), Some(&multisig_meta)])
}

/// Raw MultisigMessageId metadata bytes for `scale_message()` with 3 signatures.
fn multisig_meta_for_scale_message() -> Vec<u8> {
    let message = scale_message();
    let checkpoint = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: VERIFY_DOMAIN,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: message.nonce + 1,
        },
        message_id: message.id(),
    };
    let sigs = three_valid_sigs();
    MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: sigs
            .iter()
            .map(|s| EcdsaSignature::from_bytes(s).unwrap())
            .collect(),
    }
    .to_vec()
}

/// The per-domain ISM node: 2-of-2 Aggregation[Pausable, MultisigMessageId(7v, 3-of-7)].
fn domain_ism() -> IsmNode {
    IsmNode::Aggregation {
        threshold: 2,
        sub_isms: vec![
            IsmNode::Pausable { paused: false },
            IsmNode::MultisigMessageId {
                validators: seven_validators(),
                threshold: 3,
            },
        ],
    }
}

// ===========================================================================
// Test 1: 200 domains — Routing → Aggregation(2-of-2)[Pausable, Multisig(7v,3)]
// ===========================================================================
//
// Configures 200 domain PDAs under a single Routing root, then verifies a
// message from VERIFY_DOMAIN through the full nested ISM tree.
//
// Exercises:
//   - SetDomainIsm tx size with a 7-validator multisig config (large serialized node)
//   - Domain PDA account data size
//   - Verify heap (deserializing Aggregation + sub-ISMs from domain PDA)
//   - Compute budget (3 secp256k1 recoveries + routing/aggregation overhead)

#[tokio::test]
async fn test_scale_200_domains_aggregation_pausable_multisig() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    // ── 1. Initialize with a bare Routing root ────────────────────────────
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut banks_client,
        &payer,
        blockhash,
        IsmNode::Routing { default_ism: None },
    )
    .await
    .unwrap();

    // ── 2. Register 200 domain PDAs ───────────────────────────────────────
    // domains 1..=199 + VERIFY_DOMAIN (1234) = 200 total.
    // Each gets: Aggregation(2-of-2)[Pausable, MultisigMessageId(7v, 3-of-7)].
    let domains: Vec<u32> = (1u32..=199).chain(std::iter::once(VERIFY_DOMAIN)).collect();
    assert_eq!(domains.len(), TOTAL_DOMAINS);

    for domain in &domains {
        let blockhash = banks_client.get_latest_blockhash().await.unwrap();
        set_domain_ism(&mut banks_client, &payer, blockhash, *domain, domain_ism())
            .await
            .unwrap_or_else(|e| panic!("SetDomainIsm failed for domain {domain}: {e}"));
    }

    // ── 3. Verify a message from VERIFY_DOMAIN ────────────────────────────
    let message = scale_message();
    let metadata = build_aggregation_metadata(&message);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_all_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone())
            .await;

    // Routing reads storage PDA + domain PDA only — Aggregation and its
    // sub-ISMs are stored inline in the domain PDA, requiring no extra accounts.
    assert_eq!(account_metas.len(), 2);

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[scale] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 2: Deep nesting — 16 levels of nested single-child Aggregation
// ===========================================================================
//
// Shape: Agg[Agg[Agg[...[Test]...]]] (16 Aggregation wrappers + 1 Test leaf)
//
// Exercises the BPF call-depth limit (limit is 64 frames).  Each verify_node()
// call consumes one frame, so 17 total is well within the limit.  Also stresses
// the recursive Borsh decode stack.

/// `depth=0` → `Test{accept:true}`, `depth=N` → `Aggregation{threshold:1}[deep_ism(N-1)]`.
fn deep_ism(depth: usize) -> IsmNode {
    if depth == 0 {
        IsmNode::Test { accept: true }
    } else {
        IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![deep_ism(depth - 1)],
        }
    }
}

/// Metadata matching `deep_ism(depth)`.
fn deep_metadata(depth: usize) -> Vec<u8> {
    if depth == 0 {
        vec![]
    } else {
        let inner = deep_metadata(depth - 1);
        encode_aggregation_metadata(&[Some(&inner)])
    }
}

#[tokio::test]
async fn test_scale_deep_nesting() {
    const DEPTH: usize = 16;

    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(&mut banks_client, &payer, blockhash, deep_ism(DEPTH))
        .await
        .unwrap();

    let message = scale_message();
    let metadata = deep_metadata(DEPTH);
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;

    // Deep nesting reads everything from storage PDA — no extra accounts.
    assert_eq!(account_metas.len(), 1);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[deep_nesting depth={DEPTH}] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 3: UpdateConfig realloc — grow storage PDA from Test to Aggregation(50-of-50)
// ===========================================================================
//
// Exercises `realloc` of the storage PDA when UpdateConfig replaces a tiny
// node with a much larger one.  The account must be pre-funded to remain
// rent-exempt after the realloc, since `store(_, allow_realloc=true)` grows
// the data but does not transfer lamports.

fn wide_ism_50() -> IsmNode {
    IsmNode::Aggregation {
        threshold: 50,
        sub_isms: (0..50).map(|_| IsmNode::Test { accept: true }).collect(),
    }
}

fn wide_meta_50() -> Vec<u8> {
    let slots: Vec<Option<&[u8]>> = (0..50).map(|_| Some(&[][..])).collect();
    encode_aggregation_metadata(&slots)
}

#[tokio::test]
async fn test_scale_update_config_realloc() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    // Initialize with a minimal Test node.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut banks_client,
        &payer,
        blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    // Pre-fund the storage PDA with extra lamports so that the realloc from
    // a tiny Test node to a 50-sub-ISM Aggregation keeps it rent-exempt.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let fund_tx = solana_sdk::transaction::Transaction::new_signed_with_payer(
        &[solana_system_interface::instruction::transfer(
            &payer.pubkey(),
            &storage_pda_key(),
            1_000_000_000, // 1 SOL — covers any realistic ISM size
        )],
        Some(&payer.pubkey()),
        &[&payer],
        blockhash,
    );
    banks_client.process_transaction(fund_tx).await.unwrap();

    // Grow to 50-sub-ISM Aggregation via UpdateConfig (triggers PDA realloc).
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    update_config(&mut banks_client, &payer, blockhash, wide_ism_50())
        .await
        .unwrap_or_else(|e| panic!("UpdateConfig realloc failed: {e}"));

    // Verify through the grown Aggregation.
    let message = scale_message();
    let metadata = wide_meta_50();
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[update_config_realloc] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 4: Wide Aggregation — 50-of-50, all Test sub-ISMs
// ===========================================================================
//
// Exercises the per-verify BPF heap footprint and compute cost of iterating
// 50 sub-ISMs in a single Aggregation node stored inline in the storage PDA.

#[tokio::test]
async fn test_scale_wide_aggregation() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(&mut banks_client, &payer, blockhash, wide_ism_50())
        .await
        .unwrap();

    let message = scale_message();
    let metadata = wide_meta_50();
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;

    assert_eq!(account_metas.len(), 1);

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[wide_aggregation 50-of-50] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 5: Multisig compute budget — 3× MultisigMessageId(3v, 3-of-3) = 9 recoveries
// ===========================================================================
//
// Aggregation { threshold: 3, sub_isms: [
//   MultisigMessageId(3v, 3), MultisigMessageId(3v, 3), MultisigMessageId(3v, 3)
// ] }
//
// Each node does 3 secp256k1 recoveries → 9 total.  Stress-tests the compute
// cost of repeated EC operations in a single transaction (~380k CU observed).

fn chained_multisig_ism() -> IsmNode {
    let node = IsmNode::MultisigMessageId {
        validators: three_validators(),
        threshold: 3,
    };
    IsmNode::Aggregation {
        threshold: 3,
        sub_isms: vec![node.clone(), node.clone(), node],
    }
}

fn chained_multisig_meta() -> Vec<u8> {
    let inner = multisig_meta_for_scale_message();
    encode_aggregation_metadata(&[Some(&inner), Some(&inner), Some(&inner)])
}

#[tokio::test]
async fn test_scale_multisig_compute_budget() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(&mut banks_client, &payer, blockhash, chained_multisig_ism())
        .await
        .unwrap();

    let message = scale_message();
    let metadata = chained_multisig_meta();
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[multisig_compute_budget 9 recoveries] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 6: Verify metadata transaction size — 3×3 Aggregation of MultisigMessageId
// ===========================================================================
//
// Shape: Agg(3-of-3)[Agg(3-of-3)[MultisigMessageId(3v,3)] ×3] ×3
//
// Metadata calculation (all multisig slots filled with 3-sig metadata):
//   inner multisig meta:  32+32+4+65×3 = 263 bytes
//   level-2 agg header:   3×8 = 24 bytes  →  per level-2: 813 bytes
//   level-1 header:       3×8 = 24 bytes  →  total: 2463 bytes
//
// The 1232-byte Solana tx size limit is a UDP/network-layer constraint — it is
// NOT enforced by solana-program-test's BanksClient (neither simulate_transaction
// nor process_transaction check packet size).  The only honest way to verify the
// limit in a unit test is to assert the serialized tx size directly.
//
// This test does two things under real BPF constraints (real binary, 1.4M CU budget):
//   (a) Asserts the Verify tx for this config WOULD exceed the 1232-byte limit.
//   (b) Asserts the ISM verify logic still passes (compute ~1.14M CU, heap, stack).
//
// On mainnet, a config that produces >1232-byte metadata requires out-of-band
// metadata delivery or restructuring into smaller, tx-fitting sub-configs.
//
// Compute: 3×3 = 9 multisig leaves × 3 recoveries = 27 total.

fn deep3x3_multisig_ism() -> IsmNode {
    let leaf = IsmNode::MultisigMessageId {
        validators: three_validators(),
        threshold: 3,
    };
    let level2 = IsmNode::Aggregation {
        threshold: 3,
        sub_isms: vec![leaf.clone(), leaf.clone(), leaf.clone()],
    };
    IsmNode::Aggregation {
        threshold: 3,
        sub_isms: vec![level2.clone(), level2.clone(), level2.clone()],
    }
}

fn deep3x3_multisig_meta() -> Vec<u8> {
    let inner_multisig = multisig_meta_for_scale_message();
    let level2_meta = encode_aggregation_metadata(&[
        Some(&inner_multisig),
        Some(&inner_multisig),
        Some(&inner_multisig),
    ]);
    encode_aggregation_metadata(&[Some(&level2_meta), Some(&level2_meta), Some(&level2_meta)])
}

#[tokio::test]
async fn test_scale_verify_metadata_tx_size() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(&mut banks_client, &payer, blockhash, deep3x3_multisig_ism())
        .await
        .unwrap();

    let message = scale_message();
    let metadata = deep3x3_multisig_meta();

    // (a) Assert the Verify transaction for this config would exceed the mainnet
    // packet size limit.  BanksClient does not enforce this limit itself, so we
    // check it explicitly using a conservative estimate:
    //   metadata + serialized message + tx overhead (signatures, accounts, etc.)
    // The exact overhead is ~200 bytes, but even a loose bound is unambiguous here.
    let estimated_tx_size = metadata.len() + message.to_vec().len() + 200;
    assert!(
        estimated_tx_size > 1232,
        "expected tx to exceed the 1232-byte mainnet limit, got estimated {estimated_tx_size} bytes — \
         check test config; if it now fits, remove this scale test or increase the tree depth"
    );
    eprintln!(
        "[verify_metadata_tx_size] estimated tx bytes: {} (Solana limit: 1232; metadata alone: {})",
        estimated_tx_size,
        metadata.len()
    );

    // (b) Verify the ISM logic passes under real BPF constraints (compute, heap, stack).
    // Simulation bypasses the packet size limit, letting us measure CU cost separately.
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone()).await;

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[verify_metadata_tx_size] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}

// ===========================================================================
// Test 7: Large domain ISM via SetDomainIsm — Aggregation(2-of-2)[Multisig(7v,3) ×2]
// ===========================================================================
//
// Stresses both the SetDomainIsm transaction size (large domain PDA write) and
// the Verify heap cost of deserializing a domain PDA with two 7-validator
// multisigs stored inline.

fn dual_multisig_domain_ism() -> IsmNode {
    let multisig = IsmNode::MultisigMessageId {
        validators: seven_validators(),
        threshold: 3,
    };
    IsmNode::Aggregation {
        threshold: 2,
        sub_isms: vec![multisig.clone(), multisig],
    }
}

fn dual_multisig_domain_meta() -> Vec<u8> {
    let inner = multisig_meta_for_scale_message();
    encode_aggregation_metadata(&[Some(&inner), Some(&inner)])
}

#[tokio::test]
async fn test_scale_set_domain_ism_large_config() {
    let (mut banks_client, payer, _) = bpf_program_test().start().await;

    // Initialize with a bare Routing root.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    initialize(
        &mut banks_client,
        &payer,
        blockhash,
        IsmNode::Routing { default_ism: None },
    )
    .await
    .unwrap();

    // Register the large domain ISM.
    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    set_domain_ism(
        &mut banks_client,
        &payer,
        blockhash,
        VERIFY_DOMAIN,
        dual_multisig_domain_ism(),
    )
    .await
    .unwrap_or_else(|e| panic!("SetDomainIsm failed: {e}"));

    // Verify.
    let message = scale_message();
    let metadata = dual_multisig_domain_meta();
    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
    };

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let account_metas =
        get_all_verify_account_metas(&mut banks_client, &payer, blockhash, verify_ixn.clone())
            .await;

    // Routing: storage_pda + domain_pda (aggregation + multisigs inline).
    assert_eq!(account_metas.len(), 2);

    let result = simulate_verify(
        &mut banks_client,
        &payer,
        blockhash,
        verify_ixn,
        account_metas,
    )
    .await;

    if let Some(details) = &result.simulation_details {
        eprintln!(
            "[set_domain_ism_large_config] compute units consumed: {} / 1_400_000",
            details.units_consumed
        );
    }

    assert_simulation_ok(&result);
}
