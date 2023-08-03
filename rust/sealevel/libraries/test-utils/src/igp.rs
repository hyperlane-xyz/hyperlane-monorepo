use hyperlane_core::H256;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{signature::Signer, signer::keypair::Keypair};

use hyperlane_sealevel_igp::{
    accounts::{GasOracle, RemoteGasData, SOL_DECIMALS, TOKEN_EXCHANGE_RATE_SCALE},
    igp_pda_seeds, igp_program_data_pda_seeds,
    instruction::{
        GasOracleConfig, GasOverheadConfig, InitIgp, InitOverheadIgp, Instruction as IgpInstruction,
    },
    overhead_igp_pda_seeds,
};

use crate::process_instruction;

pub struct IgpAccounts {
    pub program: Pubkey,
    pub program_data: Pubkey,
    pub igp: Pubkey,
    pub overhead_igp: Pubkey,
}

pub fn igp_program_id() -> Pubkey {
    pubkey!("BSffRJEwRcyEkjnbjAMMfv9kv3Y3SauxsBjCdNJyM2BN")
}

pub async fn initialize_igp_accounts(
    banks_client: &mut BanksClient,
    igp_program_id: &Pubkey,
    payer: &Keypair,
    test_destination_domain: u32,
) -> Result<IgpAccounts, BanksClientError> {
    let (program_data, _program_data_bump_seed) =
        initialize_igp_program(banks_client, payer).await?;

    let salt = H256::zero();

    let (igp, overhead_igp) = setup_test_igps(
        banks_client,
        payer,
        salt,
        test_destination_domain,
        GasOracle::RemoteGasData(RemoteGasData {
            token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
            gas_price: 1u128,
            /// The number of decimals for the remote token.
            token_decimals: SOL_DECIMALS,
        }),
        None,
    )
    .await;

    Ok(IgpAccounts {
        program: *igp_program_id,
        program_data,
        igp,
        overhead_igp,
    })
}

pub async fn initialize_igp_program(
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

pub async fn initialize_igp(
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

pub async fn initialize_overhead_igp(
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

pub async fn setup_test_igps(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    domain: u32,
    gas_oracle: GasOracle,
    gas_overhead: Option<u64>,
) -> (Pubkey, Pubkey) {
    let program_id = igp_program_id();

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
