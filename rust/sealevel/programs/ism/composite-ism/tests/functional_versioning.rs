//! Functional test for the `GetProgramVersion` instruction.

mod common;

use borsh::BorshDeserialize;
use serializable_account_meta::SimulationReturnData;
use solana_sdk::{
    instruction::Instruction, message::Message, signature::Signer, transaction::Transaction,
};

use common::{composite_ism_id, program_test};

#[tokio::test]
async fn test_get_program_version() {
    let (banks_client, payer, recent_blockhash) = program_test().start().await;

    let ix = Instruction::new_with_bytes(
        composite_ism_id(),
        &package_versioned::get_program_version_instruction_data(),
        vec![],
    );

    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[ix],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();

    assert!(simulation.result.unwrap().is_ok());
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .expect("no return data");
    let result = SimulationReturnData::<String>::try_from_slice(&return_data.data)
        .expect("failed to deserialize");
    assert_eq!(result.return_data, package_versioned::PACKAGE_VERSION);
}
