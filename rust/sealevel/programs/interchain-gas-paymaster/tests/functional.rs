use hyperlane_core::{Announcement, H160};

use std::str::FromStr;

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

use hyperlane_test_utils::process_instruction;

use hyperlane_sealevel_igp::{
    accounts::{ProgramData, ProgramDataAccount},
    igp_program_data_pda_seeds,
    instruction::Instruction as IgpInstruction,
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
