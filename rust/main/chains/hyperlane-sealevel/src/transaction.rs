use std::collections::HashMap;

use hyperlane_sealevel_mailbox::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiCompiledInstruction, UiInstruction,
    UiMessage, UiTransaction, UiTransactionStatusMeta,
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
        .filter_map(|(index, tx)| filter_by_encoding(tx).map(|(tx, meta)| (index, tx, meta)))
        .filter_map(|(index, tx, meta)| {
            filter_by_validity(tx, meta)
                .map(|(hash, account_keys, instructions)| (index, hash, account_keys, instructions))
        })
        .filter_map(|(index, hash, account_keys, instructions)| {
            filter_not_relevant(
                mailbox_program_id,
                message_storage_pda_pubkey,
                hash,
                account_keys,
                instructions,
            )
            .map(|hash| (index, hash))
        })
        .collect::<Vec<(usize, H512)>>()
}

fn filter_not_relevant(
    mailbox_program_id: &Pubkey,
    message_storage_pda_pubkey: &Pubkey,
    hash: H512,
    account_keys: Vec<String>,
    instructions: Vec<UiCompiledInstruction>,
) -> Option<H512> {
    let account_index_map = account_index_map(account_keys);

    let mailbox_program_id_str = mailbox_program_id.to_string();
    let mailbox_program_index = match account_index_map.get(&mailbox_program_id_str) {
        Some(i) => *i as u8,
        None => return None, // If account keys do not contain Mailbox program, transaction is not message dispatch.
    };

    let message_storage_pda_pubkey_str = message_storage_pda_pubkey.to_string();
    let dispatch_message_pda_account_index =
        match account_index_map.get(&message_storage_pda_pubkey_str) {
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
        Ok(ii) => ii,
        Err(_) => return None, // If we cannot parse instruction data, transaction is not message dispatch.
    };

    // If the call into Mailbox program is not OutboxDispatch, transaction is not message dispatch.
    if !matches!(instruction, Instruction::OutboxDispatch(_)) {
        return None;
    }

    Some(hash)
}

fn filter_by_validity(
    tx: UiTransaction,
    meta: UiTransactionStatusMeta,
) -> Option<(H512, Vec<String>, Vec<UiCompiledInstruction>)> {
    let Some(transaction_hash) = tx
        .signatures
        .first()
        .map(|signature| decode_h512(signature))
        .and_then(|r| r.ok())
    else {
        warn!(
            transaction = ?tx,
            "transaction does not have any signatures or signatures cannot be decoded",
        );
        return None;
    };

    let UiMessage::Raw(message) = tx.message else {
        warn!(message = ?tx.message, "we expect messages in Raw format");
        return None;
    };

    let instructions = instructions(message.instructions, meta);

    Some((transaction_hash, message.account_keys, instructions))
}

fn filter_by_encoding(
    tx: EncodedTransactionWithStatusMeta,
) -> Option<(UiTransaction, UiTransactionStatusMeta)> {
    match (tx.transaction, tx.meta) {
        // We support only transactions encoded as JSON
        // We need none-empty metadata as well
        (EncodedTransaction::Json(t), Some(m)) => Some((t, m)),
        t => {
            warn!(
                ?t,
                "transaction is not encoded as json or metadata is empty"
            );
            None
        }
    }
}

fn account_index_map(account_keys: Vec<String>) -> HashMap<String, usize> {
    account_keys
        .into_iter()
        .enumerate()
        .map(|(index, key)| (key, index))
        .collect::<HashMap<String, usize>>()
}

/// Extract all instructions from transaction
fn instructions(
    instruction: Vec<UiCompiledInstruction>,
    meta: UiTransactionStatusMeta,
) -> Vec<UiCompiledInstruction> {
    let inner_instructions = match meta.inner_instructions {
        OptionSerializer::Some(ii) => ii
            .into_iter()
            .flat_map(|ii| ii.instructions)
            .flat_map(|ii| match ii {
                UiInstruction::Compiled(ci) => Some(ci),
                _ => None,
            })
            .collect::<Vec<UiCompiledInstruction>>(),
        OptionSerializer::None | OptionSerializer::Skip => vec![],
    };

    [instruction, inner_instructions].concat()
}

#[cfg(test)]
mod tests;
