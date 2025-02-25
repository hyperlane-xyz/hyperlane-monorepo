use std::fs;
use std::path::PathBuf;

use hyperlane_core::{LogMeta, U256};
use solana_transaction_status::{EncodedTransactionWithStatusMeta, UiConfirmedBlock};

use crate::log_meta_composer::{
    is_interchain_payment_instruction, is_message_delivery_instruction,
    is_message_dispatch_instruction, search_transactions,
};
use crate::utils::{decode_h256, decode_h512, decode_pubkey};

use super::LogMetaComposer;

#[test]
pub fn test_search_dispatched_message_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi").unwrap();
    let dispatched_message_pda_account =
        decode_pubkey("6eG8PheL41qLFFUtPjSYMtsp4aoAQsMgcsYwkGCB8kwT").unwrap();
    let transactions = transactions(&read_json("dispatch_message_txn.json"));

    // when
    let transaction_hashes = search_transactions(
        transactions,
        &mailbox_program_id,
        &dispatched_message_pda_account,
        is_message_dispatch_instruction,
    );

    // then
    assert_eq!(transaction_hashes.len(), 1);
}

#[test]
pub fn test_search_dispatched_message_versioned_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y").unwrap();
    let dispatched_message_pda_account =
        decode_pubkey("9g87Di4xiYVvBE5F8Atk8xorbbVD8yKqbdHRkFu5HEgw").unwrap();
    let transactions = transactions(&read_json("dispatch_message_versioned_txn.json"));

    // when
    let transaction_hashes = search_transactions(
        transactions,
        &mailbox_program_id,
        &dispatched_message_pda_account,
        is_message_dispatch_instruction,
    );

    // then
    assert_eq!(transaction_hashes.len(), 1);
}

#[test]
pub fn test_search_dispatched_message_relevant_instruction_out_of_two_in_single_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi").unwrap();
    let dispatched_message_pda_account_one =
        decode_pubkey("HkS7U5adrqR4PZfn6DUEtHzwHxF8hZzmrEkJE8UuqFmz").unwrap();
    let dispatched_message_pda_account_two =
        decode_pubkey("9qg84RiHnQmi8Qk7ZYWRs7VTtkRB42sB4UFdhLNZ15qD").unwrap();
    let transactions = transactions(&read_json(
        "dispatch_message_two_instructions_in_one_txn.json",
    ));

    // when
    let transaction_hashes_one = search_transactions(
        transactions.clone(),
        &mailbox_program_id,
        &dispatched_message_pda_account_one,
        is_message_dispatch_instruction,
    );
    let transaction_hashes_two = search_transactions(
        transactions.clone(),
        &mailbox_program_id,
        &dispatched_message_pda_account_two,
        is_message_dispatch_instruction,
    );

    // then
    assert_eq!(transaction_hashes_one.len(), 1);
    assert_eq!(transaction_hashes_two.len(), 1);
}

#[test]
pub fn test_search_delivered_message_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi").unwrap();
    let delivered_message_pda_account =
        decode_pubkey("Dj7jk47KKXvw4nseNGdyHtNHtjPes2XSfByhF8xymrtS").unwrap();
    let transactions = transactions(&read_json("delivery_message_txn.json"));

    // when
    let transaction_hashes = search_transactions(
        transactions,
        &mailbox_program_id,
        &delivered_message_pda_account,
        is_message_delivery_instruction,
    );

    // then
    assert_eq!(transaction_hashes.len(), 1);
}

#[test]
pub fn test_search_delivered_message_reverted_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y").unwrap();
    // From the successful version of the delivery in https://eclipsescan.xyz/tx/4atym7S78qpT4k9mUFWc2tu7KAHcqUxDn8fxP7RL8utooTi6frJtq9xFbM6MSSqDffTGpRSmEAMtCYisRe5m8KXb
    let delivered_message_pda_account =
        decode_pubkey("2BZdvWiiTfeeUZKAK9R8UPrV8s8HLNGbdEUtjED52ayf").unwrap();
    let transactions = transactions(&read_json("delivery_message_reverted_txn.json"));

    // when
    let transaction_hashes = search_transactions(
        transactions,
        &mailbox_program_id,
        &delivered_message_pda_account,
        is_message_delivery_instruction,
    );

    // then
    assert!(transaction_hashes.is_empty());
}

#[test]
pub fn test_search_interchain_payment_transaction() {
    // given
    let interchain_payment_program_id =
        decode_pubkey("BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv").unwrap();
    let payment_pda_account =
        decode_pubkey("9yMwrDqHsbmmvYPS9h4MLPbe2biEykcL51W7qJSDL5hF").unwrap();
    let transactions = transactions(&read_json("dispatch_message_txn.json"));

    // when
    let transaction_hashes = search_transactions(
        transactions,
        &interchain_payment_program_id,
        &payment_pda_account,
        is_interchain_payment_instruction,
    );

    // then
    assert_eq!(transaction_hashes.len(), 1);
}

#[test]
fn test_log_meta_block_with_multiple_txs_only_one_successful() {
    // This test case uses an example of a block where delivery was attempted
    // in 2 transactions, but only one was successful.
    // Successful: https://eclipsescan.xyz/tx/4atym7S78qpT4k9mUFWc2tu7KAHcqUxDn8fxP7RL8utooTi6frJtq9xFbM6MSSqDffTGpRSmEAMtCYisRe5m8KXb
    // Reverted: https://eclipsescan.xyz/tx/5F5PUWAZcBmuGaejN4qr9BjbXCMNSY2ujQ2eUTmiftYaKEE3VoU5uowttiY73ksqpGM3R4CBB7TFKBP1j3R3EUM9

    // given
    let mailbox_program_id = decode_pubkey("EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y").unwrap();
    let composer = LogMetaComposer::new(
        mailbox_program_id,
        "message delivery".to_owned(),
        is_message_delivery_instruction,
    );
    // From the successful version of the delivery in https://eclipsescan.xyz/tx/4atym7S78qpT4k9mUFWc2tu7KAHcqUxDn8fxP7RL8utooTi6frJtq9xFbM6MSSqDffTGpRSmEAMtCYisRe5m8KXb
    let delivered_message_pda_account =
        decode_pubkey("2BZdvWiiTfeeUZKAK9R8UPrV8s8HLNGbdEUtjED52ayf").unwrap();
    let block = serde_json::from_str::<UiConfirmedBlock>(&read_json(
        "delivery_message_block_multiple_txs_one_successful.json",
    ))
    .unwrap();
    let log_index = U256::zero();
    let pda_slot = block.block_height.unwrap();
    let blockhash = decode_h256(&block.blockhash).unwrap();

    // when
    let log_meta = composer
        .log_meta(block, log_index, &delivered_message_pda_account, &pda_slot)
        .unwrap();

    // then
    assert_eq!(log_meta, LogMeta {
        address: mailbox_program_id.to_bytes().into(),
        block_number: pda_slot,
        block_hash: blockhash,
        // The successful transaction and its index in the block
        transaction_id: decode_h512("4atym7S78qpT4k9mUFWc2tu7KAHcqUxDn8fxP7RL8utooTi6frJtq9xFbM6MSSqDffTGpRSmEAMtCYisRe5m8KXb").unwrap(),
        transaction_index: 33,
        log_index,
    });
}

fn read_json(path: &str) -> String {
    let relative = PathBuf::new().join("src/log_meta_composer/").join(path);
    let absolute = fs::canonicalize(relative).expect("cannot find path");
    fs::read_to_string(absolute).expect("should have been able to read the file")
}

fn transactions(json: &str) -> Vec<EncodedTransactionWithStatusMeta> {
    let transaction = serde_json::from_str::<EncodedTransactionWithStatusMeta>(json).unwrap();
    let transactions = vec![transaction];
    transactions
}
