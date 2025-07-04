use std::collections::HashMap;

use solana_sdk::{clock::Slot, pubkey::Pubkey};
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransaction, EncodedTransactionWithStatusMeta,
    UiCompiledInstruction, UiConfirmedBlock, UiInstruction, UiMessage, UiTransaction,
    UiTransactionStatusMeta,
};
use tracing::warn;

use hyperlane_core::{LogMeta, H512, U256};

use crate::error::HyperlaneSealevelError;
use crate::utils::{decode_h256, decode_h512, from_base58};

#[derive(Debug)]
pub struct LogMetaComposer {
    program_id: Pubkey,
    transaction_description: String,
    is_specified_instruction: fn(&[u8]) -> bool,
}

impl LogMetaComposer {
    pub fn new(
        program_id: Pubkey,
        transaction_description: String,
        is_specified_instruction: fn(&[u8]) -> bool,
    ) -> Self {
        Self {
            program_id,
            transaction_description,
            is_specified_instruction,
        }
    }

    pub fn log_meta(
        &self,
        block: UiConfirmedBlock,
        log_index: U256,
        pda_pubkey: &Pubkey,
        pda_slot: &Slot,
    ) -> Result<LogMeta, HyperlaneSealevelError> {
        let block_hash = decode_h256(&block.blockhash)?;

        let transactions = block
            .transactions
            .ok_or(HyperlaneSealevelError::NoTransactions(format!(
                "block which should contain {} transaction does not contain any transaction",
                self.transaction_description,
            )))?;

        let transaction_hashes = search_transactions(
            transactions,
            &self.program_id,
            pda_pubkey,
            self.is_specified_instruction,
        );

        // We expect to see that there is only one transaction
        if transaction_hashes.len() > 1 {
            Err(HyperlaneSealevelError::TooManyTransactions(format!(
                "block contains more than one {} transactions operating on the same PDA",
                self.transaction_description,
            )))?
        }

        let (transaction_index, transaction_hash) =
            transaction_hashes
                .into_iter()
                .next()
                .ok_or(HyperlaneSealevelError::NoTransactions(format!(
                "block which should contain {} transaction does not contain any after filtering",
                self.transaction_description,
            )))?;

        let log_meta = LogMeta {
            address: self.program_id.to_bytes().into(),
            block_number: *pda_slot,
            block_hash,
            transaction_id: transaction_hash,
            transaction_index: transaction_index as u64,
            log_index,
        };

        Ok(log_meta)
    }
}

pub fn is_message_dispatch_instruction(instruction_data: &[u8]) -> bool {
    use hyperlane_sealevel_mailbox::instruction::Instruction;

    let instruction = match Instruction::from_instruction_data(instruction_data) {
        Ok(ii) => ii,
        Err(_) => return false,
    };

    matches!(instruction, Instruction::OutboxDispatch(_))
}

pub fn is_message_delivery_instruction(instruction_data: &[u8]) -> bool {
    use hyperlane_sealevel_mailbox::instruction::Instruction;

    let instruction = match Instruction::from_instruction_data(instruction_data) {
        Ok(ii) => ii,
        Err(_) => return false,
    };

    matches!(instruction, Instruction::InboxProcess(_))
}

pub fn is_interchain_payment_instruction(instruction_data: &[u8]) -> bool {
    use hyperlane_sealevel_igp::instruction::Instruction;

    let instruction = match Instruction::from_instruction_data(instruction_data) {
        Ok(ii) => ii,
        Err(_) => return false,
    };

    matches!(instruction, Instruction::PayForGas(_))
}

/// This function searches for relevant transactions in the vector of provided transactions and
/// returns the relative index and hashes of such transactions.
///
/// This function takes a program identifier and the identifier for PDA and searches transactions
/// which act upon this program and the PDA.
///
/// When the vector of transaction contains all the transactions from a block and in the order
/// in which these transaction appear in the block, the function returns indexes of the relevant
/// transaction in the block.
///
/// The transaction will be searched with the following criteria:
///     1. Transaction contains program id in the list of accounts.
///     2. Transaction contains the given PDA in the list of accounts.
///     3. Transaction is executing the program upon the PDA with the specified instruction.
///
/// * `transactions` - List of transactions
/// * `program_id` - Identifier of program for which we are searching transactions for.
/// * `pda_pubkey` - Identifier for PDA the relevant transaction should operate upon.
/// * `is_specified_instruction` - Function which returns `true` for instruction which should be
///     included into the relevant transaction.
fn search_transactions(
    transactions: Vec<EncodedTransactionWithStatusMeta>,
    program_id: &Pubkey,
    pda_pubkey: &Pubkey,
    is_specified_instruction: fn(&[u8]) -> bool,
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
            filter_by_relevancy(
                program_id,
                pda_pubkey,
                hash,
                account_keys,
                instructions,
                is_specified_instruction,
            )
            .map(|hash| (index, hash))
        })
        .collect::<Vec<(usize, H512)>>()
}

fn filter_by_relevancy(
    program_id: &Pubkey,
    message_storage_pda_pubkey: &Pubkey,
    hash: H512,
    account_keys: Vec<String>,
    instructions: Vec<UiCompiledInstruction>,
    is_specified_instruction: fn(&[u8]) -> bool,
) -> Option<H512> {
    let account_index_map = account_index_map(account_keys);

    let program_id_str = program_id.to_string();
    let program_index = match account_index_map.get(&program_id_str) {
        Some(i) => *i as u8,
        None => return None, // If account keys do not contain program, transaction is not relevant
    };

    let pda_pubkey_str = message_storage_pda_pubkey.to_string();
    let pda_account_index = match account_index_map.get(&pda_pubkey_str) {
        Some(i) => *i as u8,
        None => return None, // If account keys do not contain the given PDA account, transaction is not relevant
    };

    let found = instructions
        .into_iter()
        // If program does not contain call into program, the program is not relevant
        .filter(|instruction| instruction.program_id_index == program_index)
        // If program does not operate on the given PDA account, the program is not relevant
        .filter(|instruction| instruction.accounts.contains(&pda_account_index))
        // If we cannot decode program data, the program is not relevant
        .filter_map(|instruction| from_base58(&instruction.data).ok())
        // If the call into program is not the specified instruction, the program is not relevant
        // There should be none or one relevant program in the transaction
        .any(|instruction_data| is_specified_instruction(&instruction_data));

    if !found {
        // No relevant program was found, so, transaction is not relevant
        return None;
    }

    Some(hash)
}

fn filter_by_validity(
    tx: UiTransaction,
    meta: UiTransactionStatusMeta,
) -> Option<(H512, Vec<String>, Vec<UiCompiledInstruction>)> {
    // If the transaction has an error, we skip it
    if meta.err.is_some() {
        return None;
    }

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

    // Orders the account keys in line with the behavior of compiled instructions.
    let account_keys = match &meta.loaded_addresses {
        OptionSerializer::Some(addresses) => {
            // If there are loaded addresses, we have a versioned transaction
            // that may include dynamically loaded addresses (e.g. from a lookup table).
            // The order of these is [static, dynamic writeable, dynamic readonly] and
            // follows the iter ordering of https://docs.rs/solana-sdk/latest/solana_sdk/message/struct.AccountKeys.html.
            [
                message.account_keys,
                addresses.writable.clone(),
                addresses.readonly.clone(),
            ]
            .concat()
        }
        OptionSerializer::None | OptionSerializer::Skip => {
            // There are only static addresses in the transaction.
            message.account_keys
        }
    };

    let instructions = instructions(message.instructions, meta);

    Some((transaction_hash, account_keys, instructions))
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
