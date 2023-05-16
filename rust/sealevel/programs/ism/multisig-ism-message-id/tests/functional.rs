use solana_program::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
    };

use solana_program_test::*;
use solana_sdk::{signature::{Signer}, transaction::{Transaction, TransactionError}, signer::keypair::Keypair, hash::Hash, instruction::InstructionError};
use hyperlane_sealevel_ism_multisig_ism_message_id::{
    instruction::Instruction as MultisigIsmInstruction,
    processor::process_instruction,
    access_control_pda_seeds,
    error::Error as MultisigIsmError,
    accounts::{
        AccessControlAccount,
        AccessControlData,
    },
};

async fn new_funded_keypair(banks_client: &mut BanksClient, payer: &Keypair, lamports: u64) -> Keypair {
    let keypair = Keypair::new();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            &keypair.pubkey(),
            lamports,
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
    keypair
}

async fn initialize(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> Result<(Pubkey, u8), BanksClientError> {
    let (access_control_pda_key, _access_control_pda_bump_seed) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_borsh(
            program_id,
            &MultisigIsmInstruction::Initialize,
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(access_control_pda_key, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await?;

    Ok((access_control_pda_key, _access_control_pda_bump_seed))
}

#[tokio::test]
async fn test_initialize() {
    let program_id = hyperlane_sealevel_ism_multisig_ism_message_id::id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    let (access_control_pda_key, access_control_pda_bump_seed) = initialize(
        program_id.clone(),
        &mut banks_client,
        &payer,
        recent_blockhash.clone(),
    ).await.unwrap();

    let access_control_account_data = banks_client.get_account(
        access_control_pda_key,
    ).await.unwrap().unwrap().data;
    let access_control = AccessControlAccount::fetch_data(&mut &access_control_account_data[..]).unwrap().unwrap();
    assert_eq!(
        access_control,
        Box::new(AccessControlData {
            bump_seed: access_control_pda_bump_seed,
            owner: payer.pubkey(),
        }),
    );

    // let owner_bytes = banks_client.simulate_transaction(Transaction::new_unsigned(
    //     Message::new_with_blockhash(
    //         &[
    //             Instruction::new_with_borsh(
    //                 program_id,
    //                 &MultisigIsmInstruction::GetOwner,
    //                 vec![AccountMeta::new_readonly(access_control_pda_key, false)],
    //             )
    //         ],
    //         Some(&payer.pubkey()),
    //         &recent_blockhash,
    //     ),
    // )).await.unwrap().simulation_details.unwrap().return_data.unwrap().data;
    // assert_eq!(Pubkey::new(&owner_bytes[..]), payer.pubkey());
}

#[tokio::test]
async fn test_initialize_errors_if_called_twice() {
    let program_id = hyperlane_sealevel_ism_multisig_ism_message_id::id();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "hyperlane_sealevel_ism_multisig_ism",
        program_id,
        processor!(process_instruction),
    )
    .start()
    .await;

    initialize(
        program_id.clone(),
        &mut banks_client,
        &payer,
        recent_blockhash.clone(),
    ).await.unwrap();

    // Create a new payer as a hack to get a new tx ID, because the
    // instruction data is the same and the recent blockhash is the same
    let new_payer = new_funded_keypair(&mut banks_client, &payer, 1000000).await;
    let result = initialize(
        program_id.clone(),
        &mut banks_client,
        &new_payer,
        recent_blockhash,
    ).await;

    // BanksClientError doesn't implement Eq, but TransactionError does
    if let BanksClientError::TransactionError(tx_err) = result.err().unwrap() {
        assert_eq!(tx_err, TransactionError::InstructionError(0, InstructionError::Custom(MultisigIsmError::AlreadyInitialized as u32)));
    } else {
        panic!("expected TransactionError");
    }
}
