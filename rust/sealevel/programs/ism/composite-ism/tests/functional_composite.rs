//! Functional tests for composite ISM program lifecycle operations.
//!
//! Test cases:
//! - Initialize creates the storage PDA with the correct owner and root node
//! - Initialize fails with AlreadyInitialized if called a second time
//! - Initialize fails with InvalidProgramDataAccount if wrong program_data key is passed
//! - Initialize with BPF-loader-owned ProgramData rejects non-authority signer
//! - Initialize with BPF-loader-owned ProgramData accepts upgrade authority as signer
//! - UpdateConfig replaces the root ISM tree and persists the new config
//! - UpdateConfig fails with InvalidArgument if the caller is not the owner
//! - UpdateConfig fails with AccountNotInitialized if the program has not been initialized
//! - TransferOwnership updates the stored owner to the new address
//! - TransferOwnership with None renounces ownership (owner becomes None)
//! - GetOwner returns the current owner via return data
//! - Type always returns ModuleType::Composite regardless of the root node type

mod common;

use account_utils::DiscriminatorEncode;
use borsh::BorshDeserialize;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    instruction::{
        initialize_instruction, transfer_ownership_instruction, update_config_instruction,
    },
};
use hyperlane_test_utils::assert_transaction_error;
use serializable_account_meta::SimulationReturnData;
use solana_program::instruction::AccountMeta;
use solana_program::pubkey::Pubkey;
use solana_program_test::ProgramTest;
use solana_sdk::{
    account::Account,
    instruction::InstructionError,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use hyperlane_core::ModuleType;

use common::{
    composite_ism_id, get_ism_type, initialize, new_funded_keypair, program_test, storage_pda_key,
};

/// Creates a `ProgramTest` with a mock BPF-loader-owned ProgramData account at the
/// deterministic address for `composite_ism_id()`, encoding `upgrade_authority` as
/// the stored upgrade authority.
fn program_test_with_upgrade_authority(upgrade_authority: &Pubkey) -> ProgramTest {
    let mut pt = program_test();

    let bpf_loader_upgradeable_id = solana_sdk_ids::bpf_loader_upgradeable::id();
    let (program_data_key, _) =
        Pubkey::find_program_address(&[composite_ism_id().as_ref()], &bpf_loader_upgradeable_id);

    // BPF ProgramData layout (bincode LE):
    // [0..4]  discriminant u32 = 3
    // [4..12] slot u64 = 0
    // [12]    Option tag = 1 (Some)
    // [13..45] upgrade_authority Pubkey
    let mut data = vec![0u8; 45];
    data[0..4].copy_from_slice(&3u32.to_le_bytes());
    data[12] = 1;
    data[13..45].copy_from_slice(upgrade_authority.as_ref());

    pt.add_account(
        program_data_key,
        Account {
            lamports: 1_000_000,
            data,
            owner: bpf_loader_upgradeable_id,
            executable: false,
            rent_epoch: 0,
        },
    );
    pt
}

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
    let (banks_client, payer, recent_blockhash) = program_test().start().await;

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

#[tokio::test]
async fn test_ism_type() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    initialize(
        &mut banks_client,
        &payer,
        recent_blockhash,
        IsmNode::Test { accept: true },
    )
    .await
    .unwrap();

    assert_eq!(
        get_ism_type(&mut banks_client, &payer, recent_blockhash).await,
        ModuleType::Composite,
    );
}

// ── ProgramData upgrade-authority regression tests (HLSVM-2026Q2-004) ────────

/// Passing an account whose key is not the expected ProgramData PDA must fail.
#[tokio::test]
async fn test_initialize_rejects_wrong_program_data_key() {
    let (mut banks_client, payer, recent_blockhash) = program_test().start().await;

    let (storage_pda_key, _) = Pubkey::find_program_address(
        hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS,
        &composite_ism_id(),
    );

    // Build Initialize with a wrong program_data account (system program ID instead).
    let ix = solana_sdk::instruction::Instruction::new_with_bytes(
        composite_ism_id(),
        &hyperlane_sealevel_composite_ism::instruction::Instruction::Initialize(IsmNode::Test {
            accept: true,
        })
        .encode()
        .unwrap(),
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false), // wrong key
        ],
    );
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
                hyperlane_sealevel_composite_ism::error::Error::InvalidProgramDataAccount as u32,
            ),
        ),
    );
}

/// When the ProgramData account is BPF-loader-owned (real upgradeable deployment),
/// a signer that is NOT the upgrade authority must be rejected.
#[tokio::test]
async fn test_initialize_with_bpf_loader_program_data_rejects_non_authority() {
    let upgrade_authority = Keypair::new();
    let (mut banks_client, payer, recent_blockhash) =
        program_test_with_upgrade_authority(&upgrade_authority.pubkey())
            .start()
            .await;

    // Fund the non-authority payer so the transaction can pay fees.
    let ix = initialize_instruction(
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
    // payer.pubkey() != upgrade_authority.pubkey() → must be rejected.
    let result = banks_client.process_transaction(tx).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

/// When the ProgramData account is BPF-loader-owned, the upgrade authority IS
/// permitted to initialize and becomes the stored owner.
#[tokio::test]
async fn test_initialize_with_bpf_loader_program_data_accepts_upgrade_authority() {
    let upgrade_authority = Keypair::new();
    let (mut banks_client, payer, recent_blockhash) =
        program_test_with_upgrade_authority(&upgrade_authority.pubkey())
            .start()
            .await;

    // Fund the upgrade_authority so it can pay transaction fees.
    let transfer_ix = solana_system_interface::instruction::transfer(
        &payer.pubkey(),
        &upgrade_authority.pubkey(),
        10_000_000,
    );
    let transfer_tx = Transaction::new_signed_with_payer(
        &[transfer_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transfer_tx).await.unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let ix = initialize_instruction(
        composite_ism_id(),
        upgrade_authority.pubkey(),
        IsmNode::Test { accept: true },
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&upgrade_authority.pubkey()),
        &[&upgrade_authority],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();

    // Storage PDA owner must be the upgrade authority.
    let storage_data = banks_client
        .get_account(storage_pda_key())
        .await
        .unwrap()
        .unwrap()
        .data;
    let storage = CompositeIsmAccount::fetch_data(&mut &storage_data[..])
        .unwrap()
        .unwrap();
    assert_eq!(storage.owner, Some(upgrade_authority.pubkey()));
}
