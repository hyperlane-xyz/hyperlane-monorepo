//! Functional tests for the MultisigMessageId ISM node type.
//!
//! Uses the pre-generated test data from the multisig-ism library (3 validators,
//! known ECDSA signatures over a fixed checkpoint + message).
//!
//! Test cases:
//! - Verify succeeds with a valid quorum of validator signatures (2-of-3)
//! - Verify fails with ThresholdNotMet when 2 duplicate signatures are provided for a 2-of-3 threshold (verifier requires unique validators)
//! - Verify fails with NoDomainConfig when no domain config exists for the message origin
//! - Verify fails with InvalidMetadata when the metadata is too short to parse
//! - VerifyAccountMetas returns only the storage PDA (MultisigMessageId needs no extra accounts)

mod common;

use ecdsa_signature::EcdsaSignature;
use hyperlane_core::Encode;
use hyperlane_sealevel_composite_ism::{
    accounts::{DomainConfig, IsmNode},
    error::Error,
    multisig_metadata::MultisigIsmMessageIdMetadata,
};
use hyperlane_sealevel_interchain_security_module_interface::VerifyInstruction;
use multisig_ism::test_data::{get_multisig_ism_test_data, MultisigIsmTestData};
use solana_sdk::{instruction::InstructionError, transaction::TransactionError};

use common::{
    assert_simulation_error, assert_simulation_ok, get_verify_account_metas, initialize,
    program_test, simulate_verify, storage_pda_key,
};

fn multisig_root(origin: u32, validators: Vec<hyperlane_core::H160>, threshold: u8) -> IsmNode {
    IsmNode::MultisigMessageId {
        domain_configs: vec![DomainConfig {
            origin,
            validators,
            threshold,
        }],
    }
}

#[tokio::test]
async fn test_verify_valid_signatures() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let MultisigIsmTestData {
        message,
        checkpoint,
        validators,
        signatures,
    } = get_multisig_ism_test_data();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(message.origin, validators, 2),
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.root,
        merkle_index: checkpoint.index,
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

    let MultisigIsmTestData {
        message,
        checkpoint,
        validators,
        signatures,
    } = get_multisig_ism_test_data();

    // Threshold is 2; provide 2 signatures but both from the same validator.
    // The verifier increments past a matched validator, so the duplicate can't
    // satisfy a second slot → ThresholdNotMet.
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(message.origin, validators, 2),
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.root,
        merkle_index: checkpoint.index,
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
async fn test_verify_no_domain_config() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let MultisigIsmTestData {
        message,
        checkpoint,
        validators,
        signatures,
    } = get_multisig_ism_test_data();

    // Configure for a different origin domain — no config for message.origin.
    let wrong_origin = message.origin + 1;
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(wrong_origin, validators, 1),
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
        merkle_root: checkpoint.root,
        merkle_index: checkpoint.index,
        validator_signatures: vec![EcdsaSignature::from_bytes(&signatures[0]).unwrap()],
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
            InstructionError::Custom(Error::NoDomainConfig as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_invalid_metadata() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let MultisigIsmTestData {
        message,
        validators,
        ..
    } = get_multisig_ism_test_data();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(message.origin, validators, 1),
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

    let MultisigIsmTestData {
        message,
        validators,
        ..
    } = get_multisig_ism_test_data();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        multisig_root(message.origin, validators, 1),
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
