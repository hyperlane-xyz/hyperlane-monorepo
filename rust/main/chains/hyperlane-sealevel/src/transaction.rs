use std::collections::HashMap;

use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::{EncodedTransaction, EncodedTransactionWithStatusMeta, UiMessage};

use hyperlane_core::H512;
use hyperlane_sealevel_mailbox::instruction::Instruction;

use crate::utils::{decode_h512, decode_pubkey, from_base58};

pub fn search_transaction(
    mailbox_program_id: &Pubkey,
    message_storage_pda_pubkey: &Pubkey,
    transactions: Vec<EncodedTransactionWithStatusMeta>,
) -> Vec<H512> {
    transactions
        .into_iter()
        .filter_map(|tx| match tx.transaction {
            // We support only transactions encoded as JSON initially
            EncodedTransaction::Json(t) => Some(t),
            _ => None,
        })
        .filter_map(|t| {
            let transaction_hash = t.signatures.first().unwrap().to_owned();
            let transaction_hash = match decode_h512(&transaction_hash) {
                Ok(h) => h,
                Err(_) => return None, // if we cannot parse transaction hash, we continue the search
            };

            // We support only Raw messages initially
            match t.message {
                UiMessage::Raw(m) => Some((transaction_hash, m)),
                _ => None,
            }
        })
        .filter_map(|(hash, message)| {
            let account_keys = message
                .account_keys
                .into_iter()
                .enumerate()
                .filter_map(|(index, key)| {
                    let pubkey = match decode_pubkey(&key) {
                        Ok(p) => p,
                        Err(_) => return None,
                    };
                    Some((pubkey, index))
                })
                .collect::<HashMap<Pubkey, usize>>();

            let mailbox_program_index = match account_keys.get(mailbox_program_id) {
                Some(i) => *i as u8,
                None => return None, // If account keys do not contain Mailbox program, transaction is not message dispatch.
            };

            let dispatch_message_pda_account_index =
                match account_keys.get(message_storage_pda_pubkey) {
                    Some(i) => *i as u8,
                    None => return None, // If account keys do not contain dispatch message store PDA account, transaction is not message dispatch.
                };

            let mailbox_program_maybe = message
                .instructions
                .into_iter()
                .filter(|instruction| instruction.program_id_index == mailbox_program_index)
                .next();

            let mailbox_program = match mailbox_program_maybe {
                Some(p) => p,
                None => return None, // If transaction does not contain call into Mailbox, transaction is not message dispatch.
            };

            // If Mailbox program should operate on dispatch message store PDA account, transaction is not message dispatch.
            if !mailbox_program
                .accounts
                .contains(&dispatch_message_pda_account_index)
            {
                return None;
            }

            let instruction_data = match from_base58(&mailbox_program.data) {
                Ok(d) => d,
                Err(_) => return None, // If we cannot decode instruction data, transaction is not message dispatch.
            };

            let instruction = match Instruction::from_instruction_data(&instruction_data) {
                Ok(m) => m,
                Err(_) => return None, // If we cannot parse instruction data, transaction is not message dispatch.
            };

            // If the call into Mailbox program is not OutboxDispatch, transaction is not message dispatch.
            if !matches!(instruction, Instruction::OutboxDispatch(_)) {
                return None;
            }

            Some(hash)
        })
        .collect::<Vec<H512>>()
}
