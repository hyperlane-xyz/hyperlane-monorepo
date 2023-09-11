use hyperlane_core::H256;

use std::collections::HashMap;

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
    sysvar::rent::Rent,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError, signature::Signature, signature::Signer,
    signer::keypair::Keypair, transaction::TransactionError,
};

use hyperlane_test_utils::{
    assert_transaction_error, igp_program_id, new_funded_keypair, process_instruction,
    simulate_instruction, transfer_lamports,
};
use serializable_account_meta::SimulationReturnData;

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorPrefixed, DiscriminatorPrefixedData};
use hyperlane_sealevel_igp::{
    accounts::{
        GasOracle, GasPaymentAccount, GasPaymentData, Igp, IgpAccount, OverheadIgp,
        OverheadIgpAccount, ProgramData, ProgramDataAccount, RemoteGasData, SOL_DECIMALS,
        TOKEN_EXCHANGE_RATE_SCALE,
    },
    error::Error as IgpError,
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    instruction::{
        GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp,
        Instruction as IgpInstruction, PayForGas, QuoteGasPayment,
    },
    overhead_igp_pda_seeds,
    processor::process_instruction as igp_process_instruction,
};

const TEST_DESTINATION_DOMAIN: u32 = 11111;
const TEST_GAS_AMOUNT: u64 = 300000;
const TEST_GAS_OVERHEAD_AMOUNT: u64 = 100000;
const LOCAL_DECIMALS: u8 = SOL_DECIMALS;

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = igp_program_id();
    let program_test = ProgramTest::new(
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

async fn setup_test_igps(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    domain: u32,
    gas_oracle: GasOracle,
    gas_overhead: Option<u64>,
) -> (Pubkey, Pubkey) {
    let program_id = igp_program_id();

    let salt = H256::random();

    let (igp_key, _igp_bump_seed) = initialize_igp(
        banks_client,
        payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetGasOracleConfigs(vec![GasOracleConfig {
            domain,
            gas_oracle: Some(gas_oracle),
        }]),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(banks_client, instruction, payer, &[payer])
        .await
        .unwrap();

    let (overhead_igp_key, _overhead_igp_bump_seed) =
        initialize_overhead_igp(banks_client, payer, salt, Some(payer.pubkey()), igp_key)
            .await
            .unwrap();

    if let Some(gas_overhead) = gas_overhead {
        let instruction = Instruction::new_with_borsh(
            program_id,
            &IgpInstruction::SetDestinationGasOverheads(vec![GasOverheadConfig {
                destination_domain: domain,
                gas_overhead: Some(gas_overhead),
            }]),
            vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(overhead_igp_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        );
        process_instruction(banks_client, instruction, payer, &[payer])
            .await
            .unwrap();
    }

    (igp_key, overhead_igp_key)
}

// ============ Init ============

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
        Box::new(
            ProgramData {
                bump_seed: program_data_bump_seed,
                payment_count: 0,
            }
            .into()
        ),
    );
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let _program_id = igp_program_id();
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

// ============ InitIgp ============

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
        Box::new(
            Igp {
                bump_seed: igp_bump_seed,
                salt,
                owner,
                beneficiary,
                gas_oracles: HashMap::new(),
            }
            .into()
        ),
    );
}

#[tokio::test]
async fn test_initialize_igp_errors_if_called_twice() {
    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let beneficiary = Pubkey::new_unique();

    let (_igp_key, _igp_bump_seed) =
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

// ============ InitOverheadIgp ============

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
        Box::new(
            OverheadIgp {
                bump_seed: overhead_igp_bump_seed,
                salt,
                owner,
                inner,
                gas_overheads: HashMap::new(),
            }
            .into()
        ),
    );
}

#[tokio::test]
async fn test_initialize_overhead_igp_errors_if_called_twice() {
    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let owner = Some(Pubkey::new_unique());
    let inner = Pubkey::new_unique();

    let (_overhead_igp_key, _overhead_igp_bump_seed) =
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

// ============ SetGasOracleConfigs ============

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

// ============ SetDestinationGasOverheads ============

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

// ============ QuoteGasPayment ============

async fn quote_gas_payment(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    destination_domain: u32,
    gas_amount: u64,
    igp_key: Pubkey,
    overhead_igp_key: Option<Pubkey>,
) -> Result<u64, BanksClientError> {
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(igp_key, false),
    ];
    if let Some(overhead_igp_key) = overhead_igp_key {
        accounts.push(AccountMeta::new_readonly(overhead_igp_key, false));
    }

    let instruction = Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::QuoteGasPayment(QuoteGasPayment {
            destination_domain,
            gas_amount,
        }),
        accounts,
    );

    simulate_instruction::<SimulationReturnData<u64>>(banks_client, payer, instruction)
        .await
        .map(|r| r.unwrap().return_data)
}

async fn run_quote_gas_payment_tests(gas_amount: u64, overhead_gas_amount: Option<u64>) {
    assert_eq!(
        gas_amount + overhead_gas_amount.unwrap_or_default(),
        TEST_GAS_AMOUNT
    );

    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    // Testing when exchange rates are relatively close.
    // The base asset has 9 decimals, there's a 1:1 exchange rate,
    // and the remote asset also has 9 decimals.
    let (igp_key, _overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            // 0.2 exchange rate (remote token less valuable)
            token_exchange_rate: (TOKEN_EXCHANGE_RATE_SCALE / 5),
            gas_price: 150u64.into(),       // 150 gas price
            token_decimals: LOCAL_DECIMALS, // same decimals as local
        }),
        Some(TEST_GAS_OVERHEAD_AMOUNT),
    )
    .await;

    assert_eq!(
        quote_gas_payment(
            &mut banks_client,
            &payer,
            TEST_DESTINATION_DOMAIN,
            TEST_GAS_AMOUNT,
            igp_key,
            None,
        )
        .await
        .unwrap(),
        // 300,000 destination gas
        // 150 gas price
        // 300,000 * 150 = 45000000 (0.045 remote tokens w/ 9 decimals)
        // Using the 0.2 token exchange rate, meaning the local native token
        // is 5x more valuable than the remote token:
        // 45000000 * 0.2 = 9000000 (0.009 local tokens w/ 9 decimals)
        9000000u64,
    );

    // Testing when the remote token is much more valuable, has higher decimals, & there's a super high gas price
    let (igp_key, _overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            // remote token 5000x more valuable
            token_exchange_rate: (5000 * TOKEN_EXCHANGE_RATE_SCALE),
            gas_price: 1500000000000u64.into(), // 150 gwei gas price
            token_decimals: 18,                 // remote has 18 decimals
        }),
        Some(TEST_GAS_OVERHEAD_AMOUNT),
    )
    .await;

    assert_eq!(
        quote_gas_payment(
            &mut banks_client,
            &payer,
            TEST_DESTINATION_DOMAIN,
            TEST_GAS_AMOUNT,
            igp_key,
            None,
        )
        .await
        .unwrap(),
        // 300,000 destination gas
        // 1500 gwei = 1500000000000 wei
        // 300,000 * 1500000000000 = 450000000000000000 (0.45 remote tokens w/ 18 decimals)
        // Using the 5000 * 1e19 token exchange rate, meaning the remote native token
        // is 5000x more valuable than the local token, and adjusting for decimals:
        // 450000000000000000 * 5000 * 1e-9 = 2250000000000 (2250 local tokens w/ 9 decimals)
        2250000000000u64,
    );

    // Testing when the remote token is much less valuable & there's a low gas price, but has 18 decimals
    let (igp_key, _overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            // remote token 0.04x the price
            token_exchange_rate: (4 * TOKEN_EXCHANGE_RATE_SCALE / 100),
            gas_price: 100000000u64.into(), // 0.1 gwei gas price
            token_decimals: 18,             // remote has 18 decimals
        }),
        Some(TEST_GAS_OVERHEAD_AMOUNT),
    )
    .await;

    assert_eq!(
        quote_gas_payment(
            &mut banks_client,
            &payer,
            TEST_DESTINATION_DOMAIN,
            TEST_GAS_AMOUNT,
            igp_key,
            None,
        )
        .await
        .unwrap(),
        // 300,000 destination gas
        // 0.1 gwei = 100000000 wei
        // 300,000 * 100000000 = 30000000000000 (0.00003 remote tokens w/ 18 decimals)
        // Using the 0.04 * 1e19 token exchange rate, meaning the remote native token
        // is 0.04x the price of the local token, and adjusting for decimals:
        // 30000000000000 * 0.04 * 1e-9 = 1200 (0.0000012 local tokens w/ 9 decimals)
        1200u64,
    );

    // Testing when the remote token is much less valuable & there's a low gas price, but has 4 decimals
    let (igp_key, _overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            // remote token 10x the price
            token_exchange_rate: (10 * TOKEN_EXCHANGE_RATE_SCALE),
            gas_price: 10u64.into(), // 10 gas price
            token_decimals: 4u8,     // remote has 4 decimals
        }),
        Some(TEST_GAS_OVERHEAD_AMOUNT),
    )
    .await;

    assert_eq!(
        quote_gas_payment(
            &mut banks_client,
            &payer,
            TEST_DESTINATION_DOMAIN,
            TEST_GAS_AMOUNT,
            igp_key,
            None,
        )
        .await
        .unwrap(),
        // 300,000 destination gas
        // 10 gas price
        // 300,000 * 10 = 3000000 (300.0000 remote tokens w/ 4 decimals)
        // Using the 10 * 1e19 token exchange rate, meaning the remote native token
        // is 10x the price of the local token, and adjusting for decimals:
        // 3000000 * 10 * 1e5 = 3000000000000 (3000 local tokens w/ 9 decimals)
        3000000000000u64,
    );
}

#[tokio::test]
async fn test_quote_gas_payment_no_overhead() {
    run_quote_gas_payment_tests(TEST_GAS_AMOUNT, None).await;
}

#[tokio::test]
async fn test_quote_gas_payment_with_overhead() {
    run_quote_gas_payment_tests(
        TEST_GAS_AMOUNT - TEST_GAS_OVERHEAD_AMOUNT,
        Some(TEST_GAS_OVERHEAD_AMOUNT),
    )
    .await;
}

#[tokio::test]
async fn test_quote_gas_payment_errors_if_no_gas_oracle() {
    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    let (igp_key, _overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1u128,
            token_decimals: LOCAL_DECIMALS,
        }),
        None,
    )
    .await;

    assert_transaction_error(
        quote_gas_payment(
            &mut banks_client,
            &payer,
            TEST_DESTINATION_DOMAIN + 1,
            TEST_GAS_AMOUNT,
            igp_key,
            None,
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::NoGasOracleSetForDestinationDomain as u32),
        ),
    );
}

// ============ PayForGas ============

async fn pay_for_gas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    igp: Pubkey,
    overhead_igp: Option<Pubkey>,
    destination_domain: u32,
    gas_amount: u64,
    message_id: H256,
) -> Result<(Pubkey, Keypair, Signature), BanksClientError> {
    let program_id = igp_program_id();
    let unique_payment_account = Keypair::new();
    let (igp_program_data_key, _) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);
    let (gas_payment_pda_key, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(unique_payment_account.pubkey()),
        &program_id,
    );

    // 0. [executable] The system program.
    // 1. [signer] The payer.
    // 2. [writeable] The IGP program data.
    // 3. [signer] Unique gas payment account.
    // 4. [writeable] Gas payment PDA.
    // 5. [writeable] The IGP account.
    // 6. [] Overhead IGP account (optional).
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new(igp_program_data_key, false),
        AccountMeta::new_readonly(unique_payment_account.pubkey(), true),
        AccountMeta::new(gas_payment_pda_key, false),
        AccountMeta::new(igp, false),
    ];
    if let Some(overhead_igp) = overhead_igp {
        accounts.push(AccountMeta::new_readonly(overhead_igp, false));
    }

    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::PayForGas(PayForGas {
            destination_domain,
            gas_amount,
            message_id,
        }),
        accounts,
    );

    let tx_signature = process_instruction(
        banks_client,
        instruction,
        payer,
        &[payer, &unique_payment_account],
    )
    .await?;

    Ok((gas_payment_pda_key, unique_payment_account, tx_signature))
}

#[allow(clippy::too_many_arguments)]
async fn assert_gas_payment(
    banks_client: &mut BanksClient,
    igp_key: Pubkey,
    payment_tx_signature: Signature,
    unique_gas_payment_pubkey: Pubkey,
    gas_payment_account_key: Pubkey,
    destination_domain: u32,
    gas_amount: u64,
    payment: u64,
    message_id: H256,
    sequence_number: u64,
) {
    // Get the slot of the tx
    let tx_status = banks_client
        .get_transaction_status(payment_tx_signature)
        .await
        .unwrap()
        .unwrap();
    let slot = tx_status.slot;

    // Get the gas payment account
    let gas_payment_account = banks_client
        .get_account(gas_payment_account_key)
        .await
        .unwrap()
        .unwrap();
    let gas_payment = GasPaymentAccount::fetch(&mut &gas_payment_account.data[..])
        .unwrap()
        .into_inner();
    assert_eq!(
        *gas_payment,
        GasPaymentData {
            sequence_number,
            igp: igp_key,
            destination_domain,
            message_id,
            gas_amount,
            payment,
            unique_gas_payment_pubkey,
            slot,
        }
        .into(),
    );
}

async fn run_pay_for_gas_tests(gas_amount: u64, overhead_gas_amount: Option<u64>) {
    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;
    let message_id = H256::random();

    initialize(&mut banks_client, &payer).await.unwrap();

    let (igp_key, overhead_igp_key) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1u128,
            token_decimals: LOCAL_DECIMALS,
        }),
        overhead_gas_amount,
    )
    .await;

    let quote = quote_gas_payment(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        gas_amount,
        igp_key,
        // Only pass in the overhead igp key if there's an overhead amount
        overhead_gas_amount.map(|_| overhead_igp_key),
    )
    .await
    .unwrap();

    let igp_balance_before = banks_client.get_balance(igp_key).await.unwrap();

    let (gas_payment_pda_key, unique_payment_account, payment_tx_signature) = pay_for_gas(
        &mut banks_client,
        &payer,
        igp_key,
        // Only pass in the overhead igp key if there's an overhead amount
        overhead_gas_amount.map(|_| overhead_igp_key),
        TEST_DESTINATION_DOMAIN,
        gas_amount,
        message_id,
    )
    .await
    .unwrap();

    let igp_balance_after = banks_client.get_balance(igp_key).await.unwrap();

    assert_eq!(igp_balance_after - igp_balance_before, quote,);
    assert!(quote > 0);

    assert_gas_payment(
        &mut banks_client,
        igp_key,
        payment_tx_signature,
        unique_payment_account.pubkey(),
        gas_payment_pda_key,
        TEST_DESTINATION_DOMAIN,
        gas_amount + overhead_gas_amount.unwrap_or_default(),
        quote,
        message_id,
        0,
    )
    .await;

    // Send another payment to confirm the sequence number is incremented
    let (gas_payment_pda_key, unique_payment_account, payment_tx_signature) = pay_for_gas(
        &mut banks_client,
        &payer,
        igp_key,
        // Only pass in the overhead igp key if there's an overhead amount
        overhead_gas_amount.map(|_| overhead_igp_key),
        TEST_DESTINATION_DOMAIN,
        gas_amount,
        message_id,
    )
    .await
    .unwrap();

    assert_gas_payment(
        &mut banks_client,
        igp_key,
        payment_tx_signature,
        unique_payment_account.pubkey(),
        gas_payment_pda_key,
        TEST_DESTINATION_DOMAIN,
        gas_amount + overhead_gas_amount.unwrap_or_default(),
        quote,
        message_id,
        1,
    )
    .await;
}

#[tokio::test]
async fn test_pay_for_gas_no_overhead() {
    run_pay_for_gas_tests(TEST_GAS_AMOUNT, None).await;
}

#[tokio::test]
async fn test_pay_for_gas_with_overhead() {
    run_pay_for_gas_tests(TEST_GAS_AMOUNT, Some(TEST_GAS_OVERHEAD_AMOUNT)).await;
}

#[tokio::test]
async fn test_pay_for_gas_errors_if_payer_balance_is_insufficient() {
    let _program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    let balance = 1000000000;

    let low_balance_payer = new_funded_keypair(&mut banks_client, &payer, balance).await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let (igp_key, _) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1000000000u128,
            token_decimals: LOCAL_DECIMALS,
        }),
        None,
    )
    .await;

    let quote = quote_gas_payment(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        TEST_GAS_AMOUNT,
        igp_key,
        None,
    )
    .await
    .unwrap();

    assert!(quote > balance);

    assert_transaction_error(
        pay_for_gas(
            &mut banks_client,
            &low_balance_payer,
            igp_key,
            None,
            TEST_DESTINATION_DOMAIN,
            TEST_GAS_AMOUNT,
            H256::random(),
        )
        .await,
        TransactionError::InstructionError(
            0,
            // Corresponds to `SystemError::ResultWithNegativeLamports` in the system program.
            // See https://github.com/solana-labs/solana/blob/cd39a6afd35288a0c2d3b2cf8995b29790889e69/sdk/program/src/system_instruction.rs#L61
            InstructionError::Custom(1),
        ),
    );
}

#[tokio::test]
async fn test_pay_for_gas_errors_if_no_gas_oracle() {
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let (igp_key, _) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1u128,
            token_decimals: LOCAL_DECIMALS,
        }),
        None,
    )
    .await;

    assert_transaction_error(
        pay_for_gas(
            &mut banks_client,
            &payer,
            igp_key,
            None,
            TEST_DESTINATION_DOMAIN + 1,
            TEST_GAS_AMOUNT,
            H256::random(),
        )
        .await,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::NoGasOracleSetForDestinationDomain as u32),
        ),
    );
}

// ============ Claim ============

#[tokio::test]
async fn test_claim() {
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let (igp_key, _) = setup_test_igps(
        &mut banks_client,
        &payer,
        TEST_DESTINATION_DOMAIN,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1u128,
            token_decimals: LOCAL_DECIMALS,
        }),
        None,
    )
    .await;

    let claim_amount = 1234567;
    // Transfer the claim amount to the IGP account
    transfer_lamports(&mut banks_client, &payer, &igp_key, claim_amount).await;

    let non_beneficiary = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;

    let beneficiary_balance_before = banks_client.get_balance(payer.pubkey()).await.unwrap();

    // Accounts:
    // 0. [executable] The system program.
    // 1. [writeable] The IGP.
    // 2. [writeable] The IGP beneficiary.
    process_instruction(
        &mut banks_client,
        Instruction::new_with_borsh(
            igp_program_id(),
            &IgpInstruction::Claim,
            vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(igp_key, false),
                AccountMeta::new(payer.pubkey(), false),
            ],
        ),
        &non_beneficiary,
        &[&non_beneficiary],
    )
    .await
    .unwrap();

    let beneficiary_balance_after = banks_client.get_balance(payer.pubkey()).await.unwrap();
    assert_eq!(
        beneficiary_balance_after - beneficiary_balance_before,
        claim_amount,
    );

    // Make sure the IGP account is still rent exempt
    let igp_account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    let rent_exempt_balance = Rent::default().minimum_balance(igp_account.data.len());
    assert_eq!(igp_account.lamports, rent_exempt_balance);
}

// ============ SetIgpBeneficiary ============

#[tokio::test]
async fn test_set_igp_beneficiary() {
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

    let new_beneficiary = Pubkey::new_unique();

    // Accounts:
    // 0. [] The IGP.
    // 1. [signer] The owner of the IGP account.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetIgpBeneficiary(new_beneficiary),
        vec![
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, instruction, &payer, &[&payer])
        .await
        .unwrap();

    // Expect the beneficiary to be set.
    let igp_account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    let igp = IgpAccount::fetch(&mut &igp_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(igp.beneficiary, new_beneficiary,);
}

#[tokio::test]
async fn test_set_igp_beneficiary_errors_if_owner_not_signer() {
    let program_id = igp_program_id();
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1000000000).await;
    let new_beneficiary = Pubkey::new_unique();

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

    // Accounts:
    // 0. [] The IGP.
    // 1. [signer] The owner of the IGP account.

    // Try with the right owner passed in, but it's not a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::SetIgpBeneficiary(new_beneficiary),
        vec![
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
        &IgpInstruction::SetIgpBeneficiary(new_beneficiary),
        vec![
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(non_owner.pubkey(), true),
        ],
    );
    assert_transaction_error(
        process_instruction(&mut banks_client, instruction, &non_owner, &[&non_owner]).await,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// ============ TransferIgpOwnership & TransferOverheadIgpOwnership ============

async fn run_transfer_ownership_tests<T: DiscriminatorPrefixedData + AccessControl>(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    account_key: Pubkey,
    transfer_ownership_instruction: impl Fn(Option<Pubkey>) -> IgpInstruction,
) {
    let program_id = igp_program_id();

    let new_owner = new_funded_keypair(banks_client, payer, 1000000000).await;

    // Accounts:
    // 0. [] The IGP or Overhead IGP.
    // 1. [signer] The owner of the account.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &transfer_ownership_instruction(Some(new_owner.pubkey())),
        vec![
            AccountMeta::new(account_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(banks_client, instruction.clone(), payer, &[payer])
        .await
        .unwrap();

    // Expect the owner to be set.
    let account = banks_client
        .get_account(account_key)
        .await
        .unwrap()
        .unwrap();
    let account_data = AccountData::<DiscriminatorPrefixed<T>>::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(account_data.owner(), Some(&new_owner.pubkey()),);

    // Try to transfer ownership again, but now the payer isn't the owner anymore

    // Try with the old (now incorrect) owner passed in and as a signer.
    // Use a random new owner to ensure a different tx signature is used.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &transfer_ownership_instruction(Some(Pubkey::new_unique())),
        vec![
            AccountMeta::new(account_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    assert_transaction_error(
        process_instruction(banks_client, instruction, payer, &[payer]).await,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Try with the new owner passed in, but it's not a signer
    let instruction = Instruction::new_with_borsh(
        program_id,
        &transfer_ownership_instruction(Some(new_owner.pubkey())),
        vec![
            AccountMeta::new(account_key, false),
            AccountMeta::new_readonly(new_owner.pubkey(), false),
        ],
    );
    assert_transaction_error(
        process_instruction(banks_client, instruction, payer, &[payer]).await,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );

    // Set the owner to None, and the new_owner should still not be able to transfer ownership
    let instruction = Instruction::new_with_borsh(
        program_id,
        &transfer_ownership_instruction(None),
        vec![
            AccountMeta::new(account_key, false),
            AccountMeta::new_readonly(new_owner.pubkey(), true),
        ],
    );
    process_instruction(banks_client, instruction.clone(), &new_owner, &[&new_owner])
        .await
        .unwrap();

    // Should not be able to transfer ownership anymore.
    // Try setting a different owner to ensure a different tx signature is used.
    let instruction = Instruction::new_with_borsh(
        program_id,
        &transfer_ownership_instruction(Some(Pubkey::new_unique())),
        vec![
            AccountMeta::new(account_key, false),
            AccountMeta::new_readonly(new_owner.pubkey(), true),
        ],
    );
    assert_transaction_error(
        process_instruction(banks_client, instruction, &new_owner, &[&new_owner]).await,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_transfer_igp_ownership() {
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

    run_transfer_ownership_tests::<Igp>(&mut banks_client, &payer, igp_key, |owner| {
        IgpInstruction::TransferIgpOwnership(owner)
    })
    .await;
}

#[tokio::test]
async fn test_transfer_overhead_igp_ownership() {
    let (mut banks_client, payer) = setup_client().await;

    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();

    let (overhead_igp_key, _igp_bump_seed) = initialize_overhead_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        Pubkey::new_unique(),
    )
    .await
    .unwrap();

    run_transfer_ownership_tests::<OverheadIgp>(
        &mut banks_client,
        &payer,
        overhead_igp_key,
        IgpInstruction::TransferOverheadIgpOwnership,
    )
    .await;
}
