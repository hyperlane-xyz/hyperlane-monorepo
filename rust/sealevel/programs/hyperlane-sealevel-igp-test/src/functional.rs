use hyperlane_core::{H160, H256};

use std::collections::HashMap;

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    sysvar::rent::Rent,
};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError, signature::Signature, signature::Signer,
    signer::keypair::Keypair, transaction::Transaction, transaction::TransactionError,
};
use solana_system_interface::program as system_program;

use hyperlane_test_utils::{
    assert_transaction_error, igp_program_id, new_funded_keypair, process_instruction,
    simulate_instruction, transfer_lamports,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

use access_control::AccessControl;
use account_utils::{AccountData, DiscriminatorPrefixed, DiscriminatorPrefixedData};
use hyperlane_sealevel_igp::{
    accounts::{
        compute_gas_fee, GasOracle, GasPaymentAccount, GasPaymentData, Igp, IgpAccount,
        IgpFeeConfig, IgpStandingQuote, IgpStandingQuoteAccount, IgpTransientQuote,
        IgpTransientQuoteAccount, OverheadIgp, OverheadIgpAccount, ProgramData, ProgramDataAccount,
        RemoteGasData, SOL_DECIMALS, TOKEN_EXCHANGE_RATE_SCALE, WILDCARD_DOMAIN, WILDCARD_SENDER,
    },
    error::Error as IgpError,
    igp_gas_payment_pda_seeds, igp_pda_seeds, igp_program_data_pda_seeds,
    igp_standing_quote_pda_seeds, igp_transient_quote_pda_seeds,
    instruction::{
        close_igp_standing_quote_instruction, close_igp_transient_quote_instruction,
        get_igp_quote_account_metas_instruction, set_igp_min_issued_at_instruction,
        set_igp_quote_config_instruction, set_igp_quote_signer_instruction,
        submit_igp_quote_instruction, GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp,
        Instruction as IgpInstruction, PayForGas, QuoteGasPayment, SetIgpQuoteSignerOperation,
    },
    overhead_igp_pda_seeds,
    processor::process_instruction as igp_process_instruction,
};
use k256::ecdsa::{SigningKey, VerifyingKey};
use quote_verifier::{QuoteValidationError, QuoteVerifyError, SvmSignedQuote};

const TEST_DESTINATION_DOMAIN: u32 = 11111;
const TEST_GAS_AMOUNT: u64 = 300000;
const TEST_GAS_OVERHEAD_AMOUNT: u64 = 100000;
const LOCAL_DECIMALS: u8 = SOL_DECIMALS;

async fn setup_client_with_context() -> (ProgramTestContext, Keypair) {
    let program_id = igp_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_igp",
        program_id,
        processor!(igp_process_instruction),
    );

    let ctx = program_test.start_with_context().await;
    // Set clock to a known small value so quote tests using small timestamps work.
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 2;
    ctx.set_sysvar(&clock);
    let payer = ctx.payer.insecure_clone();

    (ctx, payer)
}

async fn setup_client() -> (BanksClient, Keypair) {
    let (ctx, payer) = setup_client_with_context().await;
    (ctx.banks_client, payer)
}

async fn initialize(
    banks_client: &mut BanksClient,
    payer: &Keypair,
) -> Result<(Pubkey, u8), BanksClientError> {
    let program_id = igp_program_id();

    let (program_data_key, program_data_bump_seed) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The program data account.
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The IGP account to initialize.
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
    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer account.
    // 2. `[writeable]` The Overhead IGP account to initialize.
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
                fee_config: None,
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[signer]` The IGP owner.

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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The Overhead IGP.
    // 2. `[signer]` The Overhead IGP owner.
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The Overhead IGP.
    // 2. `[signer]` The Overhead IGP owner.

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

    // 0. `[executable]` The system program.
    // 1. `[signer]` The payer.
    // 2. `[writeable]` The IGP program data.
    // 3. `[signer]` Unique gas payment account.
    // 4. `[writeable]` Gas payment PDA.
    // 5. `[writeable]` The IGP account.
    // 6. `[]` Overhead IGP account (optional).
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
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The IGP.
    // 2. `[writeable]` The IGP beneficiary.
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
    // 0. `[]` The IGP.
    // 1. `[signer]` The owner of the IGP account.
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
    // 0. `[]` The IGP.
    // 1. `[signer]` The owner of the IGP account.

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
    // 0. `[]` The IGP or Overhead IGP.
    // 1. `[signer]` The owner of the account.
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

// --- SetIgpQuoteConfig tests ---

async fn fetch_igp(banks_client: &mut BanksClient, igp_key: Pubkey) -> Igp {
    let account = banks_client.get_account(igp_key).await.unwrap().unwrap();
    IgpAccount::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
        .data
}

#[tokio::test]
async fn test_set_igp_quote_config_enable() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    // Initially fee_config is None.
    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config, None);

    // Enable quoting.
    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 100,
    };
    let ix = set_igp_quote_config_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        Some(config.clone()),
    )
    .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config, Some(config));
}

#[tokio::test]
async fn test_set_igp_quote_config_disable() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    // Enable first.
    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 0,
    };
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), Some(config))
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Disable.
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), None).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config, None);
}

#[tokio::test]
async fn test_set_igp_quote_config_reinit_resets() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    // Set config with domain_id=42, min_issued_at=500.
    let config1 = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 500,
    };
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), Some(config1))
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Re-set with different values — should fully replace.
    let config2 = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 99,
        min_issued_at: 0,
    };
    let ix = set_igp_quote_config_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        Some(config2.clone()),
    )
    .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config, Some(config2));
}

#[tokio::test]
async fn test_set_igp_quote_config_rejects_non_owner() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1_000_000_000).await;

    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 0,
    };
    let ix = set_igp_quote_config_instruction(
        igp_program_id(),
        igp_key,
        non_owner.pubkey(),
        Some(config),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_igp_quote_config_rejects_overhead_igp() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let (overhead_igp_key, _) = initialize_overhead_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        igp_key,
    )
    .await
    .unwrap();

    // Try to set quote config on OverheadIgp — should fail (discriminator mismatch).
    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 0,
    };
    let ix = set_igp_quote_config_instruction(
        igp_program_id(),
        overhead_igp_key,
        payer.pubkey(),
        Some(config),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::BorshIoError),
    );
}

#[tokio::test]
async fn test_set_igp_quote_config_rejects_extraneous_account() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 0,
    };

    // Build instruction manually to sneak in an extra account.
    let mut ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), Some(config))
            .unwrap();
    ix.accounts
        .push(AccountMeta::new_readonly(Pubkey::new_unique(), false));

    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(account_utils::AccountError::ExtraneousAccount as u32),
        ),
    );
}

// --- AddIgpQuoteSigner tests ---

/// Helper: initialize IGP with quote config enabled.
async fn setup_igp_with_quote_config(banks_client: &mut BanksClient, payer: &Keypair) -> Pubkey {
    initialize(banks_client, payer).await.unwrap();
    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        banks_client,
        payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let config = IgpFeeConfig {
        signers: Default::default(),
        domain_id: 42,
        min_issued_at: 0,
    };
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), Some(config))
            .unwrap();
    process_instruction(banks_client, ix, payer, &[payer])
        .await
        .unwrap();

    igp_key
}

#[tokio::test]
async fn test_add_igp_quote_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let signer_addr = H160::random();
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(signer_addr),
    )
    .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    let signers = &igp.fee_config.unwrap().signers;
    assert!(signers.contains(&signer_addr));
    assert_eq!(signers.len(), 1);
}

#[tokio::test]
async fn test_add_igp_quote_signer_rejects_no_fee_config() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    // fee_config is None — should fail.
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(H160::random()),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_add_igp_quote_signer_rejects_non_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1_000_000_000).await;
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        non_owner.pubkey(),
        SetIgpQuoteSignerOperation::Add(H160::random()),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_add_igp_quote_signer_rejects_overhead_igp() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();
    let (overhead_igp_key, _) = initialize_overhead_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        igp_key,
    )
    .await
    .unwrap();

    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        overhead_igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(H160::random()),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::BorshIoError),
    );
}

#[tokio::test]
async fn test_add_igp_quote_signer_rejects_extraneous_account() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let mut ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(H160::random()),
    )
    .unwrap();
    ix.accounts
        .push(AccountMeta::new_readonly(Pubkey::new_unique(), false));

    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(account_utils::AccountError::ExtraneousAccount as u32),
        ),
    );
}

#[tokio::test]
async fn test_remove_igp_quote_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let signer_addr = H160::random();

    // Add first.
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(signer_addr),
    )
    .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert!(igp
        .fee_config
        .as_ref()
        .unwrap()
        .signers
        .contains(&signer_addr));

    // Remove.
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Remove(signer_addr),
    )
    .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    let signers = &igp.fee_config.as_ref().unwrap().signers;
    assert!(!signers.contains(&signer_addr));
    assert!(signers.is_empty());
}

#[tokio::test]
async fn test_remove_igp_quote_signer_not_found() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    // Remove a signer that was never added — should fail.
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Remove(H160::random()),
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// --- SetIgpMinIssuedAt tests ---

#[tokio::test]
async fn test_set_igp_min_issued_at() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 500).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config.unwrap().min_issued_at, 500);

    // Increase is allowed.
    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 1000).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config.unwrap().min_issued_at, 1000);
}

#[tokio::test]
async fn test_set_igp_min_issued_at_equal_allowed() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 500).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Setting same value is allowed (non-decreasing).
    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 500).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let igp = fetch_igp(&mut banks_client, igp_key).await;
    assert_eq!(igp.fee_config.unwrap().min_issued_at, 500);
}

#[tokio::test]
async fn test_set_igp_min_issued_at_monotonic_rejection() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    // Set to 1000.
    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 1000).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Try to lower to 500 — should fail.
    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 500).unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_igp_min_issued_at_rejects_no_fee_config() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 100).unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_igp_min_issued_at_rejects_non_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let non_owner = new_funded_keypair(&mut banks_client, &payer, 1_000_000_000).await;
    let ix = set_igp_min_issued_at_instruction(igp_program_id(), igp_key, non_owner.pubkey(), 100)
        .unwrap();
    let result = process_instruction(&mut banks_client, ix, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_set_igp_min_issued_at_rejects_extraneous_account() {
    let (mut banks_client, payer) = setup_client().await;
    let igp_key = setup_igp_with_quote_config(&mut banks_client, &payer).await;

    let mut ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 100).unwrap();
    ix.accounts
        .push(AccountMeta::new_readonly(Pubkey::new_unique(), false));

    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(account_utils::AccountError::ExtraneousAccount as u32),
        ),
    );
}

// --- SubmitIgpQuote helpers ---

const IGP_DOMAIN_ID: u32 = 42;

fn encode_u48(ts: i64) -> [u8; 6] {
    let mut out = [0u8; 6];
    out.copy_from_slice(&ts.to_be_bytes()[2..8]);
    out
}

fn encode_igp_context(fee_token_mint: &Pubkey, dest_domain: u32, sender: &Pubkey) -> Vec<u8> {
    let mut buf = Vec::with_capacity(68);
    buf.extend_from_slice(fee_token_mint.as_ref());
    buf.extend_from_slice(&dest_domain.to_le_bytes());
    buf.extend_from_slice(sender.as_ref());
    buf
}

fn encode_igp_data(exchange_rate: u128, gas_price: u128, token_decimals: u8) -> Vec<u8> {
    let mut buf = Vec::with_capacity(33);
    buf.extend_from_slice(&exchange_rate.to_le_bytes());
    buf.extend_from_slice(&gas_price.to_le_bytes());
    buf.push(token_decimals);
    buf
}

fn sign_hash(signing_key: &SigningKey, hash: &[u8; 32]) -> [u8; 65] {
    let (sig, recovery_id) = signing_key
        .sign_prehash_recoverable(hash)
        .expect("signing failed");
    let mut bytes = [0u8; 65];
    bytes[..64].copy_from_slice(&sig.to_bytes());
    bytes[64] = recovery_id.to_byte();
    bytes
}

fn eth_address(signing_key: &SigningKey) -> H160 {
    let verifying_key = VerifyingKey::from(signing_key);
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let hash = solana_program::keccak::hash(&pubkey_bytes.as_bytes()[1..]);
    H160::from_slice(&hash.as_ref()[12..])
}

#[allow(clippy::too_many_arguments)]
fn make_signed_igp_quote(
    signing_key: &SigningKey,
    igp_key: &Pubkey,
    domain_id: u32,
    payer: &Pubkey,
    context: Vec<u8>,
    data: Vec<u8>,
    issued_at: i64,
    expiry: i64,
) -> SvmSignedQuote {
    let client_salt = H256::random();
    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at: encode_u48(issued_at),
        expiry: encode_u48(expiry),
        client_salt,
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(payer);
    let message_hash = quote.build_message_hash(igp_key, domain_id, &scoped_salt);
    quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());
    quote
}

fn derive_standing_quote_pda(
    igp_key: &Pubkey,
    fee_token_mint: &Pubkey,
    dest_domain: u32,
    sender: &Pubkey,
) -> Pubkey {
    let dest_le = dest_domain.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        igp_standing_quote_pda_seeds!(igp_key, fee_token_mint, &dest_le, sender),
        &igp_program_id(),
    );
    pda
}

/// Sets up an IGP with quote config and a signer, returns (igp_key, signing_key).
async fn setup_igp_with_signer(
    banks_client: &mut BanksClient,
    payer: &Keypair,
) -> (Pubkey, SigningKey) {
    let igp_key = setup_igp_with_quote_config(banks_client, payer).await;

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_addr = eth_address(&signing_key);

    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(signer_addr),
    )
    .unwrap();
    process_instruction(banks_client, ix, payer, &[payer])
        .await
        .unwrap();

    (igp_key, signing_key)
}

fn fetch_standing_quote(account_data: &[u8]) -> IgpStandingQuote {
    IgpStandingQuoteAccount::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner()
        .data
}

// --- SubmitIgpQuote tests ---

#[tokio::test]
async fn test_submit_standing_quote() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let dest_domain = 137u32;
    let exchange_rate = 2_000_000_000_000_000_000u128;
    let gas_price = 50_000_000_000u128;
    let token_decimals = 18u8;

    let context = encode_igp_context(&Pubkey::default(), dest_domain, &sender);
    let data = encode_igp_data(exchange_rate, gas_price, token_decimals);

    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
        200,
    );

    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &sender);

    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Verify PDA data.
    let account = banks_client.get_account(quote_pda).await.unwrap().unwrap();
    let standing = fetch_standing_quote(&account.data);
    assert_eq!(standing.token_exchange_rate, exchange_rate);
    assert_eq!(standing.gas_price, gas_price);
    assert_eq!(standing.token_decimals, token_decimals);
    assert_eq!(standing.destination_domain, dest_domain);
    assert_eq!(standing.sender, sender);
    assert_eq!(standing.fee_token_mint, Pubkey::default());
    assert_eq!(standing.issued_at, 100);
    assert_eq!(standing.expiry, 200);
}

#[tokio::test]
async fn test_submit_standing_quote_update() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let dest_domain = 137u32;
    let context = encode_igp_context(&Pubkey::default(), dest_domain, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &sender);

    // First quote.
    let quote1 = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context.clone(),
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote1)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Update with newer issued_at.
    let quote2 = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(2_000, 200, 18),
        150,
        300,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote2)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let account = banks_client.get_account(quote_pda).await.unwrap().unwrap();
    let standing = fetch_standing_quote(&account.data);
    assert_eq!(standing.token_exchange_rate, 2_000);
    assert_eq!(standing.gas_price, 200);
    assert_eq!(standing.issued_at, 150);
}

#[tokio::test]
async fn test_submit_standing_quote_stale_rejection() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);

    // First with issued_at=150.
    let quote1 = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context.clone(),
        encode_igp_data(1_000, 100, 18),
        150,
        300,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote1)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Try older issued_at=100.
    let quote2 = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(2_000, 200, 18),
        100,
        300,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote2)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::StaleStandingQuoteUpdate as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_fully_wildcarded() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let context = encode_igp_context(&Pubkey::default(), WILDCARD_DOMAIN, &WILDCARD_SENDER);
    let quote_pda = derive_standing_quote_pda(
        &igp_key,
        &Pubkey::default(),
        WILDCARD_DOMAIN,
        &WILDCARD_SENDER,
    );

    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::FullyWildcardedQuote as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_unauthorized_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let wrong_key = SigningKey::random(&mut rand::thread_rng());
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);

    let quote = make_signed_igp_quote(
        &wrong_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteVerifyError::UnauthorizedSigner as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_non_default_fee_token() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let non_default_mint = Pubkey::new_unique();
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&non_default_mint, 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &non_default_mint, 137, &sender);

    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::NonDefaultFeeTokenMint as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_no_fee_config() {
    let (mut banks_client, payer) = setup_client().await;
    initialize(&mut banks_client, &payer).await.unwrap();

    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);

    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::QuoteConfigNotSet as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_below_min_issued_at() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    // Set min_issued_at to 500.
    let ix =
        set_igp_min_issued_at_instruction(igp_program_id(), igp_key, payer.pubkey(), 500).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);

    // issued_at=100 < min_issued_at=500.
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        200,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::StaleQuote as u32),
        ),
    );
}

#[tokio::test]
async fn test_submit_standing_quote_rejects_invalid_expiry() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);

    // expiry (50) < issued_at (100).
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        encode_igp_data(1_000, 100, 18),
        100,
        50,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::InvalidExpiry as u32),
        ),
    );
}

// --- Transient quote helpers ---

fn derive_transient_quote_pda(igp_key: &Pubkey, scoped_salt: &H256) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(igp_key, scoped_salt),
        &igp_program_id(),
    );
    pda
}

fn fetch_transient_quote(account_data: &[u8]) -> IgpTransientQuote {
    IgpTransientQuoteAccount::fetch(&mut &account_data[..])
        .unwrap()
        .into_inner()
        .data
}

/// Creates a transient quote (expiry == issued_at) and derives the PDA.
fn make_transient_igp_quote(
    signing_key: &SigningKey,
    igp_key: &Pubkey,
    domain_id: u32,
    payer: &Pubkey,
    context: Vec<u8>,
    data: Vec<u8>,
    issued_at: i64,
) -> (SvmSignedQuote, Pubkey) {
    let quote = make_signed_igp_quote(
        signing_key,
        igp_key,
        domain_id,
        payer,
        context,
        data,
        issued_at,
        issued_at, // expiry == issued_at → transient
    );
    let scoped_salt = quote.compute_scoped_salt(payer);
    let pda = derive_transient_quote_pda(igp_key, &scoped_salt);
    (quote, pda)
}

// --- Transient quote tests ---

#[tokio::test]
async fn test_submit_transient_quote() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let dest_domain = 137u32;
    let exchange_rate = 2_000_000_000_000_000_000u128;
    let gas_price = 50_000_000_000u128;
    let token_decimals = 18u8;

    let context = encode_igp_context(&Pubkey::default(), dest_domain, &sender);
    let data = encode_igp_data(exchange_rate, gas_price, token_decimals);

    let (quote, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
    );

    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Verify PDA data.
    let account = banks_client.get_account(quote_pda).await.unwrap().unwrap();
    let transient = fetch_transient_quote(&account.data);
    assert_eq!(transient.payer, payer.pubkey());
    assert_eq!(transient.destination_domain, dest_domain);
    assert_eq!(transient.sender, sender);
    assert_eq!(transient.token_exchange_rate, exchange_rate);
    assert_eq!(transient.gas_price, gas_price);
    assert_eq!(transient.token_decimals, token_decimals);
    assert_eq!(transient.expiry, 100);
}

#[tokio::test]
async fn test_submit_transient_quote_rejects_reuse_by_different_payer() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);

    // First submission succeeds (signed for payer).
    let (quote1, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context.clone(),
        data.clone(),
        100,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote1)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Second submission: different payer but manually pass the FIRST quote's PDA.
    // The new payer produces a different scoped_salt, so the PDA derivation won't match.
    // This tests InvalidSeeds (PDA mismatch), which is the actual protection against
    // a different payer trying to reuse someone else's transient PDA.
    let other_payer = new_funded_keypair(&mut banks_client, &payer, 1_000_000_000).await;
    let (quote2, _other_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &other_payer.pubkey(),
        context,
        data,
        100,
    );
    let ix = submit_igp_quote_instruction(
        igp_program_id(),
        other_payer.pubkey(),
        igp_key,
        quote_pda, // first payer's PDA — wrong for other_payer's scoped_salt
        quote2,
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &other_payer, &[&other_payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidSeeds),
    );
}

#[tokio::test]
async fn test_submit_transient_quote_rejects_duplicate() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);

    let (quote, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
    );

    let first_ix = submit_igp_quote_instruction(
        igp_program_id(),
        payer.pubkey(),
        igp_key,
        quote_pda,
        quote.clone(),
    )
    .unwrap();
    let second_ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[first_ix, second_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(tx).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(1, InstructionError::AccountAlreadyInitialized),
    );
}

#[tokio::test]
async fn test_submit_transient_quote_rejects_non_default_fee_token() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let non_default_mint = Pubkey::new_unique();
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&non_default_mint, 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);

    let (quote, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::NonDefaultFeeTokenMint as u32),
        ),
    );
}

// --- QuoteGasPayment new flow tests ---

/// Builds a QuoteGasPayment instruction with new flow accounts.
fn build_quote_gas_payment_new_flow(
    igp_key: Pubkey,
    quoted_sender: Pubkey,
    destination_domain: u32,
    gas_amount: u64,
    standing_pdas: &[Pubkey],
    overhead_igp: Option<Pubkey>,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(igp_key, false),
        AccountMeta::new_readonly(quoted_sender, false),
    ];
    for pda in standing_pdas {
        accounts.push(AccountMeta::new_readonly(*pda, false));
    }
    if let Some(overhead) = overhead_igp {
        accounts.push(AccountMeta::new_readonly(overhead, false));
    }
    Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::QuoteGasPayment(QuoteGasPayment {
            destination_domain,
            gas_amount,
        }),
        accounts,
    )
}

struct QuoteParams {
    exchange_rate: u128,
    gas_price: u128,
    token_decimals: u8,
}

/// Sets up IGP with oracle + standing quote for a specific sender.
async fn setup_igp_with_oracle_and_standing_quote(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    dest_domain: u32,
    oracle: GasOracle,
    quote: QuoteParams,
    quoted_sender: &Pubkey,
) -> (Pubkey, SigningKey) {
    let (igp_key, signing_key) = setup_igp_with_signer(banks_client, payer).await;

    // Set oracle.
    let ix = Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::SetGasOracleConfigs(vec![GasOracleConfig {
            domain: dest_domain,
            gas_oracle: Some(oracle),
        }]),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(banks_client, ix, payer, &[payer])
        .await
        .unwrap();

    // Submit standing quote.
    let context = encode_igp_context(&Pubkey::default(), dest_domain, quoted_sender);
    let data = encode_igp_data(quote.exchange_rate, quote.gas_price, quote.token_decimals);
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
        200,
    );
    let quote_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, quoted_sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(banks_client, ix, payer, &[payer])
        .await
        .unwrap();

    (igp_key, signing_key)
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_with_exact_quote() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();

    let quote_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let quote_gas_price = 50_000_000_000u128;
    let quote_decimals = 18u8;

    // Oracle has DIFFERENT pricing to verify quote takes priority.
    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: quote_exchange_rate,
            gas_price: quote_gas_price,
            token_decimals: quote_decimals,
        },
        &quoted_sender,
    )
    .await;

    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);

    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda],
        None,
    );

    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    let expected = compute_gas_fee(
        quote_exchange_rate,
        quote_gas_price,
        gas_amount,
        quote_decimals,
    )
    .unwrap();
    assert_eq!(fee, expected);
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_oracle_fallback() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();
    let other_sender = Pubkey::new_unique();

    let oracle_exchange_rate = TOKEN_EXCHANGE_RATE_SCALE;
    let oracle_gas_price = 1_000_000_000u128;
    let oracle_decimals = 9u8;

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: oracle_exchange_rate,
        gas_price: oracle_gas_price,
        token_decimals: oracle_decimals,
    });

    // Quote is for other_sender, not quoted_sender.
    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: 2 * TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 50_000_000_000,
            token_decimals: 18,
        },
        &other_sender,
    )
    .await;

    // Pass exact PDA for quoted_sender (uninitialized — no quote exists).
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);

    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda],
        None,
    );

    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    let expected = compute_gas_fee(
        oracle_exchange_rate,
        oracle_gas_price,
        gas_amount,
        oracle_decimals,
    )
    .unwrap();
    assert_eq!(fee, expected);
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_rejects_no_pdas_after_sender() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let quoted_sender = Pubkey::new_unique();

    let ix = build_quote_gas_payment_new_flow(igp_key, quoted_sender, 137, 100_000, &[], None);
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    #[allow(deprecated)]
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::NotEnoughAccountKeys),
    );
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_wildcard_sender_fallback() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();

    let ws_exchange_rate = 3 * TOKEN_EXCHANGE_RATE_SCALE;
    let ws_gas_price = 30_000_000_000u128;
    let ws_decimals = 18u8;

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    // Submit wildcard-sender quote (not an exact match for quoted_sender).
    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: ws_exchange_rate,
            gas_price: ws_gas_price,
            token_decimals: ws_decimals,
        },
        &WILDCARD_SENDER, // wildcard sender
    )
    .await;

    // Pass uninitialized exact PDA + initialized wildcard-sender PDA.
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);
    let ws_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &WILDCARD_SENDER);

    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda, ws_pda],
        None,
    );

    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    // Exact is uninitialized → falls through to wildcard-sender.
    let expected =
        compute_gas_fee(ws_exchange_rate, ws_gas_price, gas_amount, ws_decimals).unwrap();
    assert_eq!(fee, expected);
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_wildcard_domain_fallback() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();

    let wd_exchange_rate = 4 * TOKEN_EXCHANGE_RATE_SCALE;
    let wd_gas_price = 40_000_000_000u128;
    let wd_decimals = 18u8;

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    // Submit wildcard-domain quote.
    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        WILDCARD_DOMAIN, // wildcard domain
        oracle,
        QuoteParams {
            exchange_rate: wd_exchange_rate,
            gas_price: wd_gas_price,
            token_decimals: wd_decimals,
        },
        &quoted_sender,
    )
    .await;

    // Pass uninitialized exact + uninitialized ws + initialized wd.
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);
    let ws_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &WILDCARD_SENDER);
    let wd_pda = derive_standing_quote_pda(
        &igp_key,
        &Pubkey::default(),
        WILDCARD_DOMAIN,
        &quoted_sender,
    );

    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda, ws_pda, wd_pda],
        None,
    );

    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    let expected =
        compute_gas_fee(wd_exchange_rate, wd_gas_price, gas_amount, wd_decimals).unwrap();
    assert_eq!(fee, expected);
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_with_overhead() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let gas_overhead = 50_000u64;
    let quoted_sender = Pubkey::new_unique();

    let quote_exchange_rate = 2 * TOKEN_EXCHANGE_RATE_SCALE;
    let quote_gas_price = 50_000_000_000u128;
    let quote_decimals = 18u8;

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: quote_exchange_rate,
            gas_price: quote_gas_price,
            token_decimals: quote_decimals,
        },
        &quoted_sender,
    )
    .await;

    // Create overhead IGP.
    let salt = H256::random();
    let (overhead_igp_key, _) = initialize_overhead_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        igp_key,
    )
    .await
    .unwrap();

    // Set gas overhead for destination domain.
    let ix = Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::SetDestinationGasOverheads(vec![GasOverheadConfig {
            destination_domain: dest_domain,
            gas_overhead: Some(gas_overhead),
        }]),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(overhead_igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);

    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda],
        Some(overhead_igp_key),
    );

    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    // Fee should use quote pricing with overhead gas added.
    let expected = compute_gas_fee(
        quote_exchange_rate,
        quote_gas_price,
        gas_amount + gas_overhead,
        quote_decimals,
    )
    .unwrap();
    assert_eq!(fee, expected);
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_rejects_no_fee_config() {
    let (mut banks_client, payer) = setup_client().await;

    // Set up IGP WITHOUT fee_config (no SetIgpQuoteConfig call).
    initialize(&mut banks_client, &payer).await.unwrap();
    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    // Set oracle so old flow would work.
    let ix = Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::SetGasOracleConfigs(vec![GasOracleConfig {
            domain: 137,
            gas_oracle: Some(GasOracle::RemoteGasData(RemoteGasData {
                token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
                gas_price: 1_000_000_000,
                token_decimals: 9,
            })),
        }]),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let quoted_sender = Pubkey::new_unique();
    let exact_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &quoted_sender);

    // New flow with no fee_config → QuoteConfigNotSet.
    let ix =
        build_quote_gas_payment_new_flow(igp_key, quoted_sender, 137, 100_000, &[exact_pda], None);
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::QuoteConfigNotSet as u32),
        ),
    );
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_config_disabled_after_standing_quote() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    // Set up IGP with signer + standing quote.
    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: 2 * TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 50_000_000_000,
            token_decimals: 18,
        },
        &quoted_sender,
    )
    .await;

    // Disable fee_config.
    let ix =
        set_igp_quote_config_instruction(igp_program_id(), igp_key, payer.pubkey(), None).unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // New flow should now reject — config disabled, standing quote must not resolve.
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);
    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda],
        None,
    );
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::QuoteConfigNotSet as u32),
        ),
    );
}

#[tokio::test]
async fn test_quote_gas_payment_new_flow_expired_exact_falls_to_wildcard_sender() {
    let (mut ctx, payer) = setup_client_with_context().await;

    let dest_domain = 137u32;
    let gas_amount = 100_000u64;
    let quoted_sender = Pubkey::new_unique();

    let ws_exchange_rate = 3 * TOKEN_EXCHANGE_RATE_SCALE;
    let ws_gas_price = 30_000_000_000u128;
    let ws_decimals = 18u8;

    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    // Create IGP with signer + oracle.
    let (igp_key, signing_key) = setup_igp_with_signer(&mut ctx.banks_client, &payer).await;
    let ix = Instruction::new_with_borsh(
        igp_program_id(),
        &IgpInstruction::SetGasOracleConfigs(vec![GasOracleConfig {
            domain: dest_domain,
            gas_oracle: Some(oracle),
        }]),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Submit exact quote with expiry=100 (valid now at clock=2).
    let context = encode_igp_context(&Pubkey::default(), dest_domain, &quoted_sender);
    let data = encode_igp_data(5 * TOKEN_EXCHANGE_RATE_SCALE, 99_000_000_000, 18);
    let exact_quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        1,   // issued_at
        100, // expiry — valid at clock=2, expired at clock=101
    );
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);
    let ix = submit_igp_quote_instruction(
        igp_program_id(),
        payer.pubkey(),
        igp_key,
        exact_pda,
        exact_quote,
    )
    .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Submit wildcard-sender quote with expiry=500 (stays valid).
    let context = encode_igp_context(&Pubkey::default(), dest_domain, &WILDCARD_SENDER);
    let data = encode_igp_data(ws_exchange_rate, ws_gas_price, ws_decimals);
    let ws_quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        1,
        500, // stays valid at clock=101
    );
    let ws_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &WILDCARD_SENDER);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, ws_pda, ws_quote)
            .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Advance clock past exact quote's expiry but before wildcard's.
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 101;
    ctx.set_sysvar(&clock);

    // Query: expired exact should be skipped → wildcard-sender resolves.
    let ix = build_quote_gas_payment_new_flow(
        igp_key,
        quoted_sender,
        dest_domain,
        gas_amount,
        &[exact_pda, ws_pda],
        None,
    );
    let result =
        simulate_instruction::<SimulationReturnData<u64>>(&mut ctx.banks_client, &payer, ix).await;
    let fee = result.unwrap().unwrap().return_data;

    let expected =
        compute_gas_fee(ws_exchange_rate, ws_gas_price, gas_amount, ws_decimals).unwrap();
    assert_eq!(fee, expected);
}

// --- PayForGas new flow tests ---

// PayForGas new flow happy-path tests require sender_authority to be a PDA signer,
// which is only possible via invoke_signed (CPI from warp route). These will be
// tested in Phase 5 warp route E2E tests. Here we test the negative paths only.

#[tokio::test]
async fn test_pay_for_gas_new_flow_rejects_sender_authority_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let quoted_sender = Pubkey::new_unique();
    let (sender_authority, _) = Pubkey::find_program_address(
        &[b"hyperlane_dispatcher", b"-", b"dispatch_authority"],
        &quoted_sender,
    );

    let exact_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &quoted_sender);

    let unique_gas_payment = Keypair::new();

    // Build manually with sender_authority NOT as signer.
    let program_id = igp_program_id();
    let (program_data, _) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);
    let (gas_payment_pda, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(unique_gas_payment.pubkey()),
        &program_id,
    );

    let ix = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::PayForGas(PayForGas {
            message_id: H256::random(),
            destination_domain: 137,
            gas_amount: 100_000,
        }),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(program_data, false),
            AccountMeta::new_readonly(unique_gas_payment.pubkey(), true),
            AccountMeta::new(gas_payment_pda, false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(sender_authority, false), // NOT signer
            AccountMeta::new_readonly(quoted_sender, false),
            AccountMeta::new_readonly(exact_pda, false),
        ],
    );

    let result = process_instruction(
        &mut banks_client,
        ix,
        &payer,
        &[&payer, &unique_gas_payment],
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_pay_for_gas_new_flow_rejects_wrong_sender_authority() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let quoted_sender = Pubkey::new_unique();
    // Use a random keypair as sender_authority — PDA binding will fail.
    let wrong_authority = Keypair::new();

    let exact_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &quoted_sender);

    let unique_gas_payment = Keypair::new();
    let program_id = igp_program_id();
    let (program_data, _) =
        Pubkey::find_program_address(igp_program_data_pda_seeds!(), &program_id);
    let (gas_payment_pda, _) = Pubkey::find_program_address(
        igp_gas_payment_pda_seeds!(unique_gas_payment.pubkey()),
        &program_id,
    );

    let ix = Instruction::new_with_borsh(
        program_id,
        &IgpInstruction::PayForGas(PayForGas {
            message_id: H256::random(),
            destination_domain: 137,
            gas_amount: 100_000,
        }),
        vec![
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(program_data, false),
            AccountMeta::new_readonly(unique_gas_payment.pubkey(), true),
            AccountMeta::new(gas_payment_pda, false),
            AccountMeta::new(igp_key, false),
            AccountMeta::new_readonly(wrong_authority.pubkey(), true), // signer but wrong PDA
            AccountMeta::new_readonly(quoted_sender, false),
            AccountMeta::new_readonly(exact_pda, false),
        ],
    );

    let result = process_instruction(
        &mut banks_client,
        ix,
        &payer,
        &[&payer, &unique_gas_payment, &wrong_authority],
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidSeeds),
    );
}

// --- CloseIgpTransientQuote tests ---

#[tokio::test]
async fn test_close_igp_transient_quote() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);

    // Create transient quote.
    let (quote, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Verify PDA exists.
    let account = banks_client.get_account(quote_pda).await.unwrap();
    assert!(account.is_some());

    // Close it.
    let ix =
        close_igp_transient_quote_instruction(igp_program_id(), quote_pda, payer.pubkey(), igp_key)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Verify PDA is gone (system-owned, empty).
    let account = banks_client.get_account(quote_pda).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());
}

#[tokio::test]
async fn test_close_igp_transient_quote_wrong_payer() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);

    // Create transient quote with payer.
    let (quote, quote_pda) = make_transient_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
    );
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Try to close with a different payer.
    let wrong_payer = new_funded_keypair(&mut banks_client, &payer, 1_000_000_000).await;
    let ix = close_igp_transient_quote_instruction(
        igp_program_id(),
        quote_pda,
        wrong_payer.pubkey(),
        igp_key,
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &wrong_payer, &[&wrong_payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::TransientPayerMismatch as u32),
        ),
    );
}

// --- CloseIgpStandingQuote tests ---

#[tokio::test]
async fn test_close_igp_standing_quote() {
    let (mut ctx, payer) = setup_client_with_context().await;

    // Setup IGP with signer + oracle (needed for quote submission).
    let igp_key = setup_igp_with_quote_config(&mut ctx.banks_client, &payer).await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_addr = eth_address(&signing_key);
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(signer_addr),
    )
    .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Submit standing quote with expiry=100 (clock is at 2 → valid).
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        50,
        100,
    );
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Advance clock past expiry.
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 200;
    ctx.set_sysvar(&clock);

    // Close the expired standing quote. Beneficiary = payer (set during IGP init).
    let ix =
        close_igp_standing_quote_instruction(igp_program_id(), quote_pda, igp_key, payer.pubkey())
            .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Verify PDA is gone.
    let account = ctx.banks_client.get_account(quote_pda).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());
}

#[tokio::test]
async fn test_close_igp_standing_quote_not_expired() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, signing_key) = setup_igp_with_signer(&mut banks_client, &payer).await;

    // Submit standing quote with expiry=200 (clock is at 2 → NOT expired).
    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        100,
        200,
    );
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Try to close — not expired yet.
    let ix =
        close_igp_standing_quote_instruction(igp_program_id(), quote_pda, igp_key, payer.pubkey())
            .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::StandingQuoteNotExpired as u32),
        ),
    );
}

#[tokio::test]
async fn test_close_igp_standing_quote_wrong_beneficiary() {
    let (mut ctx, payer) = setup_client_with_context().await;

    let igp_key = setup_igp_with_quote_config(&mut ctx.banks_client, &payer).await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let ix = set_igp_quote_signer_instruction(
        igp_program_id(),
        igp_key,
        payer.pubkey(),
        SetIgpQuoteSignerOperation::Add(eth_address(&signing_key)),
    )
    .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    let sender = Pubkey::new_unique();
    let context = encode_igp_context(&Pubkey::default(), 137, &sender);
    let data = encode_igp_data(1_000, 100, 18);
    let quote = make_signed_igp_quote(
        &signing_key,
        &igp_key,
        IGP_DOMAIN_ID,
        &payer.pubkey(),
        context,
        data,
        50,
        100,
    );
    let quote_pda = derive_standing_quote_pda(&igp_key, &Pubkey::default(), 137, &sender);
    let ix =
        submit_igp_quote_instruction(igp_program_id(), payer.pubkey(), igp_key, quote_pda, quote)
            .unwrap();
    process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer])
        .await
        .unwrap();

    // Advance clock past expiry.
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 200;
    ctx.set_sysvar(&clock);

    // Try to close with wrong beneficiary.
    let wrong_beneficiary = Pubkey::new_unique();
    let ix = close_igp_standing_quote_instruction(
        igp_program_id(),
        quote_pda,
        igp_key,
        wrong_beneficiary,
    )
    .unwrap();
    let result = process_instruction(&mut ctx.banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::BeneficiaryMismatch as u32),
        ),
    );
}

// --- GetIgpQuoteAccountMetas tests ---

#[tokio::test]
async fn test_get_igp_quote_account_metas_trims_at_valid_exact() {
    let (mut banks_client, payer) = setup_client().await;

    let dest_domain = 137u32;
    let quoted_sender = Pubkey::new_unique();
    let oracle = GasOracle::RemoteGasData(RemoteGasData {
        token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
        gas_price: 1_000_000_000,
        token_decimals: 9,
    });

    // Setup IGP with oracle + exact standing quote.
    let (igp_key, _) = setup_igp_with_oracle_and_standing_quote(
        &mut banks_client,
        &payer,
        dest_domain,
        oracle,
        QuoteParams {
            exchange_rate: 2 * TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 50_000_000_000,
            token_decimals: 18,
        },
        &quoted_sender,
    )
    .await;

    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);

    let ix = get_igp_quote_account_metas_instruction(
        igp_program_id(),
        igp_key,
        dest_domain,
        quoted_sender,
        None,
    )
    .unwrap();

    let result = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        &mut banks_client,
        &payer,
        ix,
    )
    .await;
    let metas = result.unwrap().unwrap().return_data;

    // Fixed prefix (8) + only exact PDA (1) = 9 accounts.
    // Exact is valid → ws and wd trimmed.
    assert_eq!(metas.len(), 9);
    assert_eq!(metas[8].pubkey, exact_pda);
}

#[tokio::test]
async fn test_get_igp_quote_account_metas_returns_all_when_none_valid() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let dest_domain = 137u32;
    let quoted_sender = Pubkey::new_unique();

    // No standing quotes submitted — all PDAs uninitialized.
    let exact_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &quoted_sender);
    let ws_pda =
        derive_standing_quote_pda(&igp_key, &Pubkey::default(), dest_domain, &WILDCARD_SENDER);
    let wd_pda = derive_standing_quote_pda(
        &igp_key,
        &Pubkey::default(),
        WILDCARD_DOMAIN,
        &quoted_sender,
    );

    let ix = get_igp_quote_account_metas_instruction(
        igp_program_id(),
        igp_key,
        dest_domain,
        quoted_sender,
        None,
    )
    .unwrap();

    let result = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        &mut banks_client,
        &payer,
        ix,
    )
    .await;
    let metas = result.unwrap().unwrap().return_data;

    // Fixed prefix (8) + all 3 PDAs = 11 accounts.
    assert_eq!(metas.len(), 11);
    assert_eq!(metas[8].pubkey, exact_pda);
    assert_eq!(metas[9].pubkey, ws_pda);
    assert_eq!(metas[10].pubkey, wd_pda);
}

#[tokio::test]
async fn test_get_igp_quote_account_metas_transient_only() {
    let (mut banks_client, payer) = setup_client().await;
    let (igp_key, _) = setup_igp_with_signer(&mut banks_client, &payer).await;

    let dest_domain = 137u32;
    let quoted_sender = Pubkey::new_unique();
    let scoped_salt = H256::random();

    let (expected_transient_pda, _) = Pubkey::find_program_address(
        igp_transient_quote_pda_seeds!(igp_key, scoped_salt),
        &igp_program_id(),
    );

    let ix = get_igp_quote_account_metas_instruction(
        igp_program_id(),
        igp_key,
        dest_domain,
        quoted_sender,
        Some(scoped_salt),
    )
    .unwrap();

    let result = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        &mut banks_client,
        &payer,
        ix,
    )
    .await;
    let metas = result.unwrap().unwrap().return_data;

    // Fixed prefix (8) + transient PDA only (1) = 9. No standing PDAs.
    assert_eq!(metas.len(), 9);
    assert_eq!(metas[8].pubkey, expected_transient_pda);
    assert!(metas[8].is_writable);
    assert!(!metas[8].is_signer);
}

#[tokio::test]
async fn test_get_igp_quote_account_metas_rejects_no_fee_config() {
    let (mut banks_client, payer) = setup_client().await;

    // IGP without fee_config.
    initialize(&mut banks_client, &payer).await.unwrap();
    let salt = H256::random();
    let (igp_key, _) = initialize_igp(
        &mut banks_client,
        &payer,
        salt,
        Some(payer.pubkey()),
        payer.pubkey(),
    )
    .await
    .unwrap();

    let ix = get_igp_quote_account_metas_instruction(
        igp_program_id(),
        igp_key,
        137,
        Pubkey::new_unique(),
        None,
    )
    .unwrap();
    let result = process_instruction(&mut banks_client, ix, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(IgpError::QuoteConfigNotSet as u32),
        ),
    );
}
