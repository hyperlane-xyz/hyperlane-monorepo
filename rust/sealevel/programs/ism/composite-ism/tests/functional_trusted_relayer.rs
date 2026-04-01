//! Functional tests for the TrustedRelayer ISM node type.
//!
//! The TrustedRelayer ISM verifies that a specific relayer account signed the transaction.
//! In the relayer's case this is the identity keypair — a separate key from the fee-payer
//! that co-signs each process transaction.
//!
//! Test cases:
//! - Verify succeeds when the configured relayer's pubkey is listed as a signer in the tx
//! - Verify fails with InvalidRelayer when a different account is provided instead of the relayer
//! - Verify fails with RelayerNotSigner when the relayer pubkey is present but is_signer=false
//! - VerifyAccountMetas returns the relayer pubkey as a signer account (plus the storage PDA)
//! - Type returns ModuleType::Null

mod common;

use hyperlane_core::{Encode, ModuleType};
use hyperlane_sealevel_composite_ism::{accounts::IsmNode, error::Error};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use solana_program::instruction::AccountMeta;
use solana_sdk::{
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use common::{
    assert_simulation_error, assert_simulation_ok, composite_ism_id, dummy_message, get_ism_type,
    initialize, program_test, storage_pda_key,
};

#[tokio::test]
async fn test_verify_correct_relayer() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    // The storage PDA is account 0; the relayer is account 1 with is_signer=true.
    // Even in an unsigned simulation, the SVM sets is_signer based on the message's
    // required-signers list, which is determined by the AccountMeta.is_signer flags.
    let result = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[solana_sdk::instruction::Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Verify(verify_ixn)
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(storage_pda_key(), false),
                    AccountMeta::new_readonly(relayer.pubkey(), true), // is_signer=true
                ],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert_simulation_ok(&result);
}

#[tokio::test]
async fn test_verify_wrong_relayer() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let configured_relayer = Keypair::new();
    let wrong_relayer = Keypair::new();

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: configured_relayer.pubkey(),
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    // Pass a different pubkey as the relayer account — program should reject it.
    let result = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[solana_sdk::instruction::Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Verify(verify_ixn)
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(storage_pda_key(), false),
                    AccountMeta::new_readonly(wrong_relayer.pubkey(), true),
                ],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::InvalidRelayer as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_relayer_not_signer() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };

    // Correct relayer pubkey but is_signer=false — program should reject with RelayerNotSigner.
    let result = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[solana_sdk::instruction::Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Verify(verify_ixn)
                    .encode()
                    .unwrap(),
                vec![
                    AccountMeta::new_readonly(storage_pda_key(), false),
                    AccountMeta::new_readonly(relayer.pubkey(), false), // is_signer=false
                ],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert_simulation_error(
        &result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(Error::RelayerNotSigner as u32),
        ),
    );
}

#[tokio::test]
async fn test_verify_account_metas_returns_relayer_as_signer() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await
    .unwrap();

    let msg = dummy_message();
    let verify_ixn = VerifyInstruction {
        metadata: vec![],
        message: msg.to_vec(),
    };
    let account_metas =
        common::get_verify_account_metas(&mut banks_client, &payer, recent_blockhash, verify_ixn)
            .await;

    // Expect: [storage_pda (non-signer), relayer (signer)]
    assert_eq!(account_metas.len(), 2);
    assert_eq!(account_metas[0].pubkey, storage_pda_key());
    assert!(!account_metas[0].is_signer);
    assert_eq!(account_metas[1].pubkey, relayer.pubkey());
    assert!(account_metas[1].is_signer);
}

#[tokio::test]
async fn test_ism_type() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let relayer = Keypair::new();
    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::TrustedRelayer {
            relayer: relayer.pubkey(),
        },
    )
    .await
    .unwrap();

    assert_eq!(
        get_ism_type(&mut banks_client, &payer, recent_blockhash).await,
        ModuleType::Null,
    );
}
