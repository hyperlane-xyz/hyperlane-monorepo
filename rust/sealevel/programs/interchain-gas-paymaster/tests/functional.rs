use hyperlane_core::{Announcement, H160, H256};

use std::collections::HashMap;

use account_utils::SizedData;
use borsh::BorshSerialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use hyperlane_test_utils::{assert_transaction_error, new_funded_keypair, process_instruction};

use hyperlane_sealevel_igp::{
    accounts::{
        GasOracle, Igp, IgpAccount, OverheadIgp, OverheadIgpAccount, ProgramData,
        ProgramDataAccount, RemoteGasData,
    },
    igp_pda_seeds, igp_program_data_pda_seeds,
    instruction::{
        GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp, Instruction as IgpInstruction,
    },
    overhead_igp_pda_seeds,
    processor::process_instruction as igp_process_instruction,
};

fn igp_program_id() -> Pubkey {
    pubkey!("BSffRJEwRcyEkjnbjAMMfv9kv3Y3SauxsBjCdNJyM2BN")
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = igp_program_id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_igp",
        program_id,
        processor!(igp_process_instruction),
    );

    let (banks_client, payer, _recent_blockhash) = program_test.start().await;

    (banks_client, payer)
}

async fn initialize(
    banks_client: &mut BanksClient,
    payer: &Keypair,
) -> Result<(Pubkey, u8), BanksClientError> {
    let program_id = igp_program_id();

    let (program_data_key, program_data_bump_seed) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The program data account.
    let init_instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::Init,
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new(program_data_key, false),
        ],
    );

    process_instruction(banks_client, init_instruction, payer, &[payer]).await?;

    Ok((program_data_key, program_data_bump_seed))
}

#[tokio::test]
async fn test_initialize() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    let (program_data_key, program_data_bump_seed) =
        initialize(&mut banks_client, &payer).await.unwrap();

    // Expect the program data account to be initialized.
    let program_data_account = banks_client
        .get_account(program_data_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(program_data_account.owner, program_id);

    let program_data = ProgramDataAccount::fetch(&mut &program_data_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        program_data,
        Box::new(ProgramData {
            bump_seed: program_data_bump_seed,
            payment_count: 0,
        }),
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    // Use another payer to force a different tx id, as the blockhash used for the tx is likely to be the same as the first init tx.
    let other_payer = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;

    let result = initialize(&mut banks_client, &other_payer).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

async fn initialize_igp(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    owner: Option<Pubkey>,
    beneficiary: Pubkey,
) -> Result<(Pubkey, u8), BanksClientError> {
    let program_id = igp_program_id();

    let (igp_key, igp_bump_seed) = Pubkey::find_program_address(igp_pda_seeds!(salt), &program_id);

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The IGP account to initialize.
    let init_instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::InitIgp(InitIgp {
            salt,
            owner,
            beneficiary,
        }),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new(igp_key, false),
        ],
    );

    process_instruction(banks_client, init_instruction, payer, &[payer]).await?;

    Ok((igp_key, igp_bump_seed))
}

async fn initialize_overhead_igp(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    owner: Option<Pubkey>,
    inner: Pubkey,
) -> Result<(Pubkey, u8), BanksClientError> {
    let program_id = igp_program_id();

    let (overhead_igp_key, overhead_igp_bump_seed) =
        Pubkey::find_program_address(overhead_igp_pda_seeds!(salt), &program_id);

    // Accounts:
    // 0. [executable] The system program.
    // 1. [signer] The payer account.
    // 2. [writeable] The Overhead IGP account to initialize.
    let init_instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::InitOverheadIgp(InitOverheadIgp { salt, owner, inner }),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new(overhead_igp_key, false),
        ],
    );

    process_instruction(banks_client, init_instruction, payer, &[payer]).await?;

    Ok((overhead_igp_key, overhead_igp_bump_seed))
}

#[tokio::test]
async fn test_initialize_igp() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let beneficiary = Pubkey::new_unique();

    let (igp_key, igp_bump_seed) =
        initialize_igp(&mut banks_client, &payer, salt, owner, beneficiary)
            .await
            .unwrap();

    // Expect the igp account to be initialized.
    let igp_account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    assert_eq!(igp_account.owner, program_id);

    let igp = IgpAccount::fetch(&mut &igp_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        igp,
        Box::new(Igp {
            bump_seed: igp_bump_seed,
            salt,
            owner,
            beneficiary,
            gas_oracles: HashMap::new(),
        }),
    );
}

#[tokio::test]
async fn test_initialize_igp_errors_if_called_twice() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let beneficiary = Pubkey::new_unique();

    let (igp_key, igp_bump_seed) =
        initialize_igp(&mut banks_client, &payer, salt, owner, beneficiary)
            .await
            .unwrap();

    // Different owner used to cause the tx ID to be different.
    let result = initialize_igp(&mut banks_client, &payer, salt, None, beneficiary).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

#[tokio::test]
async fn test_initialize_overhead_igp() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let inner = Pubkey::new_unique();

    let (overhead_igp_key, overhead_igp_bump_seed) =
        initialize_overhead_igp(&mut banks_client, &payer, salt, owner, inner)
            .await
            .unwrap();

    // Expect the overhead igp account to be initialized.
    let overhead_igp_account = banks_client
        .get_account(overhead_igp_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(overhead_igp_account.owner, program_id);

    let overhead_igp = OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        overhead_igp,
        Box::new(OverheadIgp {
            bump_seed: overhead_igp_bump_seed,
            salt,
            owner,
            inner,
            gas_overheads: HashMap::new(),
        }),
    );
}

#[tokio::test]
async fn test_initialize_overhead_igp_errors_if_called_twice() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let inner = Pubkey::new_unique();

    let (overhead_igp_key, overhead_igp_bump_seed) =
        initialize_overhead_igp(&mut banks_client, &payer, salt, owner, inner)
            .await
            .unwrap();

    // Different owner used to cause the tx ID to be different.
    let result = initialize_overhead_igp(&mut banks_client, &payer, salt, None, inner).await;

    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
    );
}

#[tokio::test]
async fn test_set_gas_oracle_configs() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();

    let (igp_key, _igp_bump_seed) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let configs = vec![
        GasOracleConfig {
            domain: 11,
            gas_oracle: Some(GasOracle::RemoteGasData(RemoteGasData {
                token_exchange_rate: 112233445566u128,
                gas_price: 123456u128,
                token_decimals: 18u8,
            })),
        },
        GasOracleConfig {
            domain: 12,
            gas_oracle: Some(GasOracle::RemoteGasData(RemoteGasData {
                token_exchange_rate: 665544332211u128,
                gas_price: 654321u128,
                token_decimals: 6u8,
            })),
        },
    ];

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The IGP.
    // 2. [signer] The IGP owner.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetGasOracleConfigs(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Expect the gas oracle configs to be set.
    let igp_account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    let igp = IgpAccount::fetch(&mut &igp_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(
        igp.gas_oracles,
        configs
            .iter()
            .cloned()
            .map(|c| (c.domain, c.gas_oracle.unwrap()))
            .collect(),
    );

    // Remove one of them
    let rm_configs = vec![GasOracleConfig {
        domain: 12,
        gas_oracle: None,
    }];

    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetGasOracleConfigs(rm_configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Make sure the other one is still there
    let igp_account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    let igp = IgpAccount::fetch(&mut &igp_account.data[..])
        .unwrap()
        .into_inner();

    let remaining_config = configs[0].clone();

    assert_eq!(
        igp.gas_oracles,
        HashMap::from([(
            remaining_config.domain,
            remaining_config.gas_oracle.unwrap(),
        )]),
    );
}

#[tokio::test]
async fn test_set_gas_oracle_configs_errors_if_owner_not_signer() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;

    let salt = H256::random();

    let (igp_key, _igp_bump_seed) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let configs = vec![GasOracleConfig {
        domain: 11,
        gas_oracle: Some(GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: 112233445566u128,
            gas_price: 123456u128,
            token_decimals: 18u8,
        })),
    }];

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The IGP.
    // 2. [signer] The IGP owner.

    // Try with the correct owner passed in, but it's not a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetGasOracleConfigs(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), false),
        ],
    );
    assert_transaction_error(
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );

    // Try with the wrong owner passed in, but it's a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetGasOracleConfigs(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(non_owner.pubkey(), true),
        ],
    );
    assert_transaction_error(
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_destination_gas_overheads() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let inner = Pubkey::new_unique();

    let (overhead_igp_key, _overhead_igp_bump_seed) =
        initialize_overhead_igp(&mut banks_client, &payer, salt, Some(payer.pubkey()), inner)
            .await
            .unwrap();

    let configs = vec![
        GasOverheadConfig {
            destination_domain: 11,
            gas_overhead: Some(112233),
        },
        GasOverheadConfig {
            destination_domain: 12,
            gas_overhead: Some(332211),
        },
    ];

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The Overhead IGP.
    // 2. [signer] The Overhead IGP owner.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetDestinationGasOverheads(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(overhead_igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Expect the configs to be set.
    let overhead_igp_account = banks_client
        .get_account(overhead_igp_key)
        .await
        .unwrap()
        .unwrap();
    let overhead_igp = OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(
        overhead_igp.gas_overheads,
        configs
            .iter()
            .cloned()
            .map(|c| (c.destination_domain, c.gas_overhead.unwrap()))
            .collect(),
    );

    // Remove one of them
    let rm_configs = vec![GasOverheadConfig {
        destination_domain: 12,
        gas_overhead: None,
    }];

    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetDestinationGasOverheads(rm_configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(overhead_igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Make sure the other one is still there
    let overhead_igp_account = banks_client
        .get_account(overhead_igp_key)
        .await
        .unwrap()
        .unwrap();
    let overhead_igp = OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
        .unwrap()
        .into_inner();

    let remaining_config = configs[0].clone();

    assert_eq!(
        overhead_igp.gas_overheads,
        HashMap::from([(
            remaining_config.destination_domain,
            remaining_config.gas_overhead.unwrap(),
        )]),
    );
}

#[tokio::test]
async fn test_set_destination_gas_overheads_errors_if_owner_not_signer() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;

    let salt = H256::random();
    let inner = Pubkey::new_unique();

    let (overhead_igp_key, _overhead_igp_bump_seed) =
        initialize_overhead_igp(&mut banks_client, &payer, salt, Some(payer.pubkey()), inner)
            .await
            .unwrap();

    let configs = vec![GasOverheadConfig {
        destination_domain: 11,
        gas_overhead: Some(112233),
    }];

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The Overhead IGP.
    // 2. [signer] The Overhead IGP owner.

    // Try with the correct owner passed in, but it's not a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetDestinationGasOverheads(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(overhead_igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), false),
        ],
    );
    assert_transaction_error(
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );

    // Try with the wrong owner passed in, but it's a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetDestinationGasOverheads(configs.clone()),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(overhead_igp_key, false),
            AccountMeta::new_readonly(non_owner.pubkey(), true),
        ],
    );
    assert_transaction_error(
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// #[tokio::test]
