//! Functional tests for the MultisigMessageId ISM node type.
//!
//! Uses hardcoded ECDSA test fixtures (3 validators, known signatures over a
//! fixed checkpoint + message). The composite ISM stores validators and threshold
//! directly — domain routing is handled externally by a `Routing` node.
//!
//! CONFIG:
//! - Initialize stores the MultisigMessageId root node in the PDA.
//!
//! VERIFY:
//! - Verify succeeds with a valid quorum of validator signatures (2-of-3).
//! - Verify fails with ThresholdNotMet when 2 duplicate signatures are provided.
//! - Verify fails with InvalidMetadata when the metadata is too short to parse.
//! - VerifyAccountMetas returns only the storage PDA (no extra accounts needed).

mod common;

use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, H160, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    error::Error,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use multisig_ism::MultisigIsmMessageIdMetadata;
use solana_sdk::{instruction::InstructionError, signature::Signer, transaction::TransactionError};
use std::str::FromStr;

use common::{
    assert_simulation_error, assert_simulation_ok, get_verify_account_metas, initialize,
    program_test, simulate_verify, storage_pda_key,
};

const ORIGIN_DOMAIN: u32 = 1234u32;
const DESTINATION_DOMAIN: u32 = 4321u32;

fn test_message() -> hyperlane_core::HyperlaneMessage {
    hyperlane_core::HyperlaneMessage {
        version: 3,
        nonce: 69,
        origin: ORIGIN_DOMAIN,
        sender: H256::from_str(
            "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
        )
        .unwrap(),
        destination: DESTINATION_DOMAIN,
        recipient: H256::from_str(
            "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
        )
        .unwrap(),
        body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }
}

fn test_checkpoint(message: &hyperlane_core::HyperlaneMessage) -> CheckpointWithMessageId {
    CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: ORIGIN_DOMAIN,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: message.nonce + 1,
        },
        message_id: message.id(),
    }
}

fn test_validators() -> Vec<H160> {
    vec![
        H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
        H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
        H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
    ]
}

fn test_signatures() -> Vec<Vec<u8>> {
    vec![
        hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap(),
        hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap(),
        hex::decode("5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b").unwrap(),
    ]
}

fn multisig_root(validators: Vec<H160>, threshold: u8) -> IsmNode {
    IsmNode::MultisigMessageId {
        validators,
        threshold,
    }
}

// ── CONFIG ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let root = multisig_root(test_validators(), 1);
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

// ── VERIFY ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_verify_valid_signatures() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let message = test_message();
    let checkpoint = test_checkpoint(&message);
    let signatures = test_signatures();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(test_validators(), 2),
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
        ],
    }
    .to_vec();

    let verify_ixn = VerifyInstruction {
        metadata: metadata.clone(),
        message: message.to_vec(),
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
async fn test_verify_threshold_not_met() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let message = test_message();
    let checkpoint = test_checkpoint(&message);
    let signatures = test_signatures();

    // Threshold is 2; provide 2 signatures but both from the same validator.
    // The verifier increments past a matched validator, so the duplicate can't
    // satisfy a second slot → ThresholdNotMet.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(test_validators(), 2),
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.checkpoint.root,
        merkle_index: checkpoint.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&signatures[0]).unwrap(), // duplicate
        ],
    }
    .to_vec();

    let verify_ixn = VerifyInstruction {
        metadata,
        message: message.to_vec(),
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
            InstructionError::Custom(Error::ThresholdNotMet as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_invalid_metadata() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let message = test_message();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(test_validators(), 1),
    )
    .await
    .unwrap();

    // Metadata too short to contain even one signature (needs at least 68+65 bytes).
    let verify_ixn = VerifyInstruction {
        metadata: vec![0u8; 10],
        message: message.to_vec(),
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
            InstructionError::Custom(Error::InvalidMetadata as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_account_metas_no_extra_accounts() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let message = test_message();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(test_validators(), 1),
    )
    .await
    .unwrap();

    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: message.to_vec(),
    };
    let account_metas =
        get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn).await;

    // MultisigMessageId reads all state from the storage PDA — no extra accounts needed.
    assert_eq!(account_metas.len(), 1);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
}
