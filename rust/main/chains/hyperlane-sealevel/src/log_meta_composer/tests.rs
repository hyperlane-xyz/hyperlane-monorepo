use std::fs;
use std::path::PathBuf;

use solana_transaction_status::EncodedTransactionWithStatusMeta;

use crate::log_meta_composer::{
    is_interchain_payment_instruction, is_message_delivery_instruction,
    is_message_dispatch_instruction, search_transactions,
};
use crate::utils::decode_pubkey;

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
    assert!(!transaction_hashes.is_empty());
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
    assert!(!transaction_hashes.is_empty());
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
    assert!(!transaction_hashes.is_empty());
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
