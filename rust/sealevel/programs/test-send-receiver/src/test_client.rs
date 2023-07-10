//! Test client for the TestSendReceiver program.

use borsh::BorshSerialize;
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{signature::Signature, signature::Signer, signer::keypair::Keypair};

use hyperlane_sealevel_mailbox::{
    instruction::OutboxDispatch, mailbox_dispatched_message_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds,
};
use hyperlane_test_utils::{mailbox_id, process_instruction, MailboxAccounts};

use crate::{
    id,
    program::{HandleMode, IsmReturnDataMode, TestSendReceiverInstruction},
    test_send_receiver_storage_pda_seeds,
};

/// Test client for the TestSendReceiver program.
pub struct TestSendReceiverTestClient {
    banks_client: BanksClient,
    payer: Keypair,
}

impl TestSendReceiverTestClient {
    /// Creates a new `TestSendReceiverTestClient`.
    pub fn new(banks_client: BanksClient, payer: Keypair) -> Self {
        Self {
            banks_client,
            payer,
        }
    }

    /// Initializes the TestSendReceiver program.
    pub async fn init(&mut self) -> Result<(), BanksClientError> {
        let program_id = id();

        let payer_pubkey = self.payer.pubkey();

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::Init(mailbox_id())
                .try_to_vec()
                .unwrap(),
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

    /// Sets the ISM.
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
        .await?;

        Ok(())
    }

    /// Sets the behavior when handling a message.
    pub async fn set_handle_mode(&mut self, mode: HandleMode) -> Result<(), BanksClientError> {
        let program_id = id();

        let (storage_pda_key, _storage_pda_bump) =
            Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::SetHandleMode(mode)
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
        .await?;

        Ok(())
    }

    /// Dispatches a message.
    pub async fn dispatch(
        &mut self,
        mailbox_accounts: &MailboxAccounts,
        outbox_dispatch: OutboxDispatch,
    ) -> Result<(Signature, Keypair, Pubkey), BanksClientError> {
        let program_id = id();

        let unique_message_account_keypair = Keypair::new();

        let (dispatch_authority_key, _expected_dispatch_authority_bump) =
            Self::get_dispatch_authority();

        let (dispatched_message_account_key, _dispatched_message_bump) =
            Pubkey::find_program_address(
                mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
                &mailbox_accounts.program,
            );

        let instruction = Instruction {
            program_id,
            data: TestSendReceiverInstruction::Dispatch(outbox_dispatch)
                .try_to_vec()
                .unwrap(),
            accounts: vec![
                // 0. [executable] The Mailbox program.
                // And now the accounts expected by the Mailbox's OutboxDispatch instruction:
                // 1. [writeable] Outbox PDA.
                // 2. [] This program's dispatch authority.
                // 3. [executable] System program.
                // 4. [executable] SPL Noop program.
                // 5. [signer] Payer.
                // 6. [signer] Unique message account.
                // 7. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
                //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(dispatch_authority_key, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_account_key, false),
            ],
        };

        let tx_signature = process_instruction(
            &mut self.banks_client,
            instruction,
            &self.payer,
            &[&self.payer, &unique_message_account_keypair],
        )
        .await?;

        Ok((
            tx_signature,
            unique_message_account_keypair,
            dispatched_message_account_key,
        ))
    }

    fn get_storage_pda_key() -> Pubkey {
        let program_id = id();
        let (storage_pda_key, _storage_pda_bump) =
            Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), &program_id);
        storage_pda_key
    }

    fn get_dispatch_authority() -> (Pubkey, u8) {
        let program_id = id();
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), &program_id)
    }

    /// Returns the program ID.
    pub fn id(&self) -> Pubkey {
        id()
    }
}
