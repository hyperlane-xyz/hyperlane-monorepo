//! Test client for the Test ISM program.

use borsh::BorshSerialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{signature::Signer, signer::keypair::Keypair};

use hyperlane_test_transaction_utils::process_instruction;

use crate::{id, program::TestIsmInstruction, test_ism_storage_pda_seeds};

/// Test client for the Test ISM program.
pub struct TestIsmTestClient {
    banks_client: BanksClient,
    payer: Keypair,
}

impl TestIsmTestClient {
    /// Creates a new `TestIsmTestClient`.
    pub fn new(banks_client: BanksClient, payer: Keypair) -> Self {
        Self {
            banks_client,
            payer,
        }
    }

    /// Initializes the Test ISM program.
    pub async fn init(&mut self) -> Result<(), BanksClientError> {
        let program_id = id();

        let payer_pubkey = self.payer.pubkey();

        let instruction = Instruction {
            program_id,
            data: TestIsmInstruction::Init.try_to_vec().unwrap(),
            accounts: vec![
                // 0. [executable] System program.
                // 1. [signer] Payer.
                // 2. [writeable] Storage PDA.
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(payer_pubkey, true),
                AccountMeta::new(Self::get_storage_pda_key(), false),
            ],
        };

        process_instruction(
            &mut self.banks_client,
            instruction,
            &self.payer,
            &[&self.payer],
        )
        .await?;

        Ok(())
    }

    /// Sets the Test ISM to accept or reject.
    pub async fn set_accept(&mut self, accept: bool) -> Result<(), BanksClientError> {
        let program_id = id();

        let instruction = Instruction {
            program_id,
            data: TestIsmInstruction::SetAccept(accept).try_to_vec().unwrap(),
            accounts: vec![
                // 0. [writeable] Storage PDA.
                AccountMeta::new(Self::get_storage_pda_key(), false),
            ],
        };

        process_instruction(
            &mut self.banks_client,
            instruction,
            &self.payer,
            &[&self.payer],
        )
        .await?;

        Ok(())
    }

    fn get_storage_pda_key() -> Pubkey {
        let program_id = id();
        let (storage_pda_key, _storage_pda_bump) =
            Pubkey::find_program_address(test_ism_storage_pda_seeds!(), &program_id);
        storage_pda_key
    }

    /// Gets the program ID.
    pub fn id(&self) -> Pubkey {
        id()
    }
}
