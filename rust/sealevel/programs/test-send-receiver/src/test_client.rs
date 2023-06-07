use borsh::BorshSerialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{signature::Signer, signer::keypair::Keypair};

use hyperlane_test_utils::process_instruction;

use crate::{
    id,
    program::{IsmReturnDataMode, TestSendReceiverInstruction},
    test_send_receiver_storage_pda_seeds,
};

pub struct TestSendReceiverTestClient {
    banks_client: BanksClient,
    payer: Keypair,
}

impl TestSendReceiverTestClient {
    pub fn new(banks_client: BanksClient, payer: Keypair) -> Self {
        Self {
            banks_client,
            payer,
        }
    }

    pub async fn init(&mut self) -> Result<(), BanksClientError> {
        let program_id = id();

        let payer_pubkey = self.payer.pubkey();

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::Init.try_to_vec().unwrap(),
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
        .await
    }

    pub async fn set_ism(
        &mut self,
        ism: Option<Pubkey>,
        ism_return_data_mode: IsmReturnDataMode,
    ) -> Result<(), BanksClientError> {
        let program_id = id();

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::SetInterchainSecurityModule(
                ism,
                ism_return_data_mode,
            )
            .try_to_vec()
            .unwrap(),
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
        .await
    }

    pub async fn set_fail_handle(&mut self, fail_handle: bool) -> Result<(), BanksClientError> {
        let program_id = id();

        let (storage_pda_key, _storage_pda_bump) =
            Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::SetFailHandle(fail_handle)
                .try_to_vec()
                .unwrap(),
            accounts: vec![
                // 0. [writeable] Storage PDA.
                AccountMeta::new(storage_pda_key, false),
            ],
        };

        process_instruction(
            &mut self.banks_client,
            instruction,
            &self.payer,
            &[&self.payer],
        )
        .await
    }

    fn get_storage_pda_key() -> Pubkey {
        let program_id = id();
        let (storage_pda_key, _storage_pda_bump) =
            Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);
        storage_pda_key
    }

    pub fn id(&self) -> Pubkey {
        id()
    }
}
