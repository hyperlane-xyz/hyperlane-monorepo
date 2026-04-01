//! Functional tests for composite ISM program lifecycle operations.
//!
//! Test cases:
//! - Initialize creates the storage PDA with the correct owner and root node
//! - Initialize fails with AlreadyInitialized if called a second time
//! - Initialize fails with InvalidConfig if the root has an invalid config (threshold > sub-ISMs)
//! - UpdateConfig replaces the root ISM tree and persists the new config
//! - UpdateConfig fails with InvalidArgument if the caller is not the owner
//! - UpdateConfig fails with AccountNotInitialized if the program has not been initialized
//! - TransferOwnership updates the stored owner to the new address
//! - TransferOwnership with None renounces ownership (owner becomes None)
//! - GetOwner returns the current owner via return data

mod common;

use account_utils::DiscriminatorEncode;
use borsh::BorshDeserialize;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    instruction::{transfer_ownership_instruction, update_config_instruction},
};
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use hyperlane_test_utils::assert_transaction_error;
use serializable_account_meta::SimulationReturnData;
use solana_program::instruction::AccountMeta;
use solana_program::pubkey::Pubkey;
use solana_sdk::{
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use common::{composite_ism_id, initialize, new_funded_keypair, program_test, storage_pda_key};

#[tokio::test]
async fn test_initialize() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    let root = IsmNode::Test { accept: true };

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

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;
    let root = IsmNode::Test { accept: true };

    initialize(&mut banks_client, &payer, recent_blockhash, root.clone())
        .await
        .unwrap();

    // Use a new funded keypair to get a distinct transaction ID.
    let other_payer = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;
    let result = initialize(&mut banks_client, &other_payer, recent_blockhash, root).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(
                hyperlane_sealevel_composite_ism::error::Error::AlreadyInitialized as u32,
            ),
        ),
    );
}

#[tokio::test]
async fn test_initialize_invalid_config() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    // Aggregation with threshold > sub-ISM count is invalid.
    let root = IsmNode::Aggregation {
        threshold: 3,
        sub_isms: vec![
            IsmNode::Test { accept: true },
            IsmNode::Test { accept: true },
        ],
    };

    let result = initialize(&mut banks_client, &payer, recent_blockhash, root).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(
                hyperlane_sealevel_composite_ism::error::Error::InvalidConfig as u32,
            ),
        ),
    );
}

#[tokio::test]
async fn test_update_config() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let new_root = IsmNode::Pausable { paused: false };
    let ix =
        update_config_instruction(composite_ism_id(), payer.pubkey(), new_root.clone()).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

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
}

#[tokio::test]
async fn test_update_config_not_owner() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1_000_000).await;
    let ix = update_config_instruction(
        composite_ism_id(),
        non_owner.pubkey(),
        IsmNode::Test { accept: false },
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&non_owner.pubkey()),
        &[&non_owner],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(tx).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_update_config_not_initialized() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let ix = update_config_instruction(
        composite_ism_id(),
        payer.pubkey(),
        IsmNode::Test { accept: true },
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(tx).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(
                hyperlane_sealevel_composite_ism::error::Error::ProgramIdNotOwner as u32,
            ),
        ),
    );
}

#[tokio::test]
async fn test_transfer_ownership() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let new_owner = Keypair::new();
    let ix = transfer_ownership_instruction(
        composite_ism_id(),
        payer.pubkey(),
        Some(new_owner.pubkey()),
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    let storage_data = banks_client
        .get_account(storage_pda_key())
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = CompositeIsmAccount::fetch_data(&mut &storage_data[..])
        .unwrap()
        .unwrap();

    assert_eq!(storage.owner, Some(new_owner.pubkey()));
}

#[tokio::test]
async fn test_renounce_ownership() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let ix = transfer_ownership_instruction(composite_ism_id(), payer.pubkey(), None).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    let storage_data = banks_client
        .get_account(storage_pda_key())
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = CompositeIsmAccount::fetch_data(&mut &storage_data[..])
        .unwrap()
        .unwrap();

    assert_eq!(storage.owner, None);
}

#[tokio::test]
async fn test_get_owner() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    let storage_pda = storage_pda_key();
    let return_data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[solana_sdk::instruction::Instruction::new_with_bytes(
                composite_ism_id(),
                &hyperlane_sealevel_composite_ism::instruction::Instruction::GetOwner
                    .encode()
                    .unwrap(),
                vec![AccountMeta::new_readonly(storage_pda, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;

    let owner: Option<Pubkey> =
        SimulationReturnData::<Option<Pubkey>>::try_from_slice(&return_data)
            .unwrap()
            .return_data;

    assert_eq!(owner, Some(payer.pubkey()));
}
