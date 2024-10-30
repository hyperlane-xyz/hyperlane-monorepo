use std::collections::HashMap;

use hyperlane_sealevel_mailbox::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiCompiledInstruction, UiInstruction,
    UiMessage,
};
use tracing::warn;

use hyperlane_core::H512;

use crate::utils::{decode_h512, from_base58};

/// This function searches for a transaction which dispatches Hyperlane message and returns
/// list of hashes of such transactions.
///
/// This function takes the mailbox program identifier and the identifier for PDA for storing
/// a dispatched message and searches a message dispatch transaction in a list of transaction.
/// The list of transaction is usually comes from a block. The function returns list of hashes
/// of such transactions.
///
/// The transaction will be searched with the following criteria:
///     1. Transaction contains Mailbox program id in the list of accounts.
///     2. Transaction contains dispatched message PDA in the list of accounts.
///     3. Transaction is performing message dispatch (OutboxDispatch).
///
/// * `mailbox_program_id` - Identifier of Mailbox program
/// * `message_storage_pda_pubkey` - Identifier for dispatch message store PDA
/// * `transactions` - List of transactions
pub fn search_dispatched_message_transactions(
    mailbox_program_id: &Pubkey,
    message_storage_pda_pubkey: &Pubkey,
    transactions: Vec<EncodedTransactionWithStatusMeta>,
) -> Vec<(usize, H512)> {
    transactions
        .into_iter()
        .enumerate()
        .filter_map(|(index, tx)| match (tx.transaction, tx.meta) {
            // We support only transactions encoded as JSON
            // We need none-empty metadata as well
            (EncodedTransaction::Json(t), Some(m)) => Some((index, t, m)),
            t => {
                warn!(
                    ?t,
                    "transaction is not encoded as json or metadata is empty"
                );
                None
            }
        })
        .filter_map(|(index, tx, meta)| {
            let transaction_hash = match tx.signatures.first() {
                Some(h) => h,
                None => {
                    warn!("transaction does not have any signatures");
                    return None;
                } // if transaction is not signed, we continue the search
            };

            let transaction_hash = match decode_h512(transaction_hash) {
                Ok(h) => h,
                Err(_) => {
                    warn!(?transaction_hash, "cannot decode transaction hash");
                    return None;
                } // if we cannot parse transaction hash, we continue the search
            };

            // We support only Raw messages initially
            let message = match tx.message {
                UiMessage::Raw(m) => m,
                _ => {
                    warn!("we expect messages in Raw format");
                    return None;
                }
            };

            let inner_instructions = match meta.inner_instructions {
                OptionSerializer::Some(ii) => ii
                    .into_iter()
                    .flat_map(|ii| ii.instructions)
                    .flat_map(|ii| match ii {
                        UiInstruction::Compiled(ci) => Some(ci),
                        _ => None,
                    })
                    .collect::<Vec<UiCompiledInstruction>>(),
                OptionSerializer::None | OptionSerializer::Skip => return None,
            };

            let instructions = [message.instructions, inner_instructions].concat();

            Some((index, transaction_hash, message.account_keys, instructions))
        })
        .filter_map(|(index, hash, account_keys, instructions)| {
            let account_keys = account_keys
                .into_iter()
                .enumerate()
                .map(|(index, key)| (key, index))
                .collect::<HashMap<String, usize>>();

            let mailbox_program_id_str = mailbox_program_id.to_string();
            let mailbox_program_index = match account_keys.get(&mailbox_program_id_str) {
                Some(i) => *i as u8,
                None => return None, // If account keys do not contain Mailbox program, transaction is not message dispatch.
            };

            let message_storage_pda_pubkey_str = message_storage_pda_pubkey.to_string();
            let dispatch_message_pda_account_index =
                match account_keys.get(&message_storage_pda_pubkey_str) {
                    Some(i) => *i as u8,
                    None => return None, // If account keys do not contain dispatch message store PDA account, transaction is not message dispatch.
                };

            let mailbox_program_maybe = instructions
                .into_iter()
                .find(|instruction| instruction.program_id_index == mailbox_program_index);

            let mailbox_program = match mailbox_program_maybe {
                Some(p) => p,
                None => return None, // If transaction does not contain call into Mailbox, transaction is not message dispatch.
            };

            // If Mailbox program does not operate on dispatch message store PDA account, transaction is not message dispatch.
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

            Some((index, hash))
        })
        .collect::<Vec<(usize, H512)>>()
}

#[cfg(test)]
mod tests;
