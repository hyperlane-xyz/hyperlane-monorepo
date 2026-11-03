use std::fs;
use std::path::PathBuf;

use hyperlane_core::{ChainCommunicationError, ChainResult, LogMeta, U256};
use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_custom_error::JSON_RPC_SERVER_ERROR_SLOT_SKIPPED,
    rpc_request::{RpcError, RpcResponseErrorData},
};
use solana_transaction_status::{EncodedTransactionWithStatusMeta, UiConfirmedBlock};

use crate::error::HyperlaneSealevelError;
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

#[test]
fn test_log_meta_block_with_txn_interchain_payment_search_solaxy() {
    // This test case uses an example of a block where a message was dispatched from the Solaxy chain.
    // We should be able to find the interchain payment details in the block.
    // Transaction in the block - https://explorer.solaxy.io/tx/3wVK8GxSe6U1T9SE33Rh6GG52wRJZ1fQwRaJp7iCvkJ7MGVQVYLxpG51K4RwduYRPm4Tt7Lh81M5ArVutToNxNwq

    // given
    let interchain_payment_program_id =
        decode_pubkey("VG7YDF5Am2hrgyydE2ufdusdtw5DjgzXJLFxn9p8ehU").unwrap();
    let composer = LogMetaComposer::new(
        interchain_payment_program_id,
        "interchain gas payment".to_owned(),
        is_interchain_payment_instruction,
    );

    let payment_pda_account =
        decode_pubkey("4hWzwVjSd2Mi9kKxJuYGEL9j4dPnTtLSSBp3txR1egPM").unwrap();
    let block = serde_json::from_str::<UiConfirmedBlock>(&read_json(
        "dispatch_message_block_interchain_payment_search_solaxy.json",
    ))
    .unwrap();
    let log_index = U256::zero();
    let pda_slot = block.block_height.unwrap();
    let blockhash = decode_h256(&block.blockhash).unwrap();

    // when
    let log_meta = composer
        .log_meta(block, log_index, &payment_pda_account, &pda_slot)
        .unwrap();

    // then
    assert_eq!(log_meta, LogMeta {
        address: interchain_payment_program_id.to_bytes().into(),
        block_number: pda_slot,
        block_hash: blockhash,
        // The successful transaction and its index in the block
        transaction_id: decode_h512("3wVK8GxSe6U1T9SE33Rh6GG52wRJZ1fQwRaJp7iCvkJ7MGVQVYLxpG51K4RwduYRPm4Tt7Lh81M5ArVutToNxNwq").unwrap(),
        transaction_index: 0,
        log_index,
    });
}

/// Solaxy can record a PDA slot one ahead of the block containing the transaction.
fn solaxy_payment_composer() -> (
    LogMetaComposer,
    solana_sdk::pubkey::Pubkey,
    UiConfirmedBlock,
) {
    let composer = LogMetaComposer::new(
        decode_pubkey("VG7YDF5Am2hrgyydE2ufdusdtw5DjgzXJLFxn9p8ehU").unwrap(),
        "interchain gas payment".to_owned(),
        is_interchain_payment_instruction,
    );
    let payment_pda_account =
        decode_pubkey("4hWzwVjSd2Mi9kKxJuYGEL9j4dPnTtLSSBp3txR1egPM").unwrap();
    let block = serde_json::from_str::<UiConfirmedBlock>(&read_json(
        "dispatch_message_block_interchain_payment_search_solaxy.json",
    ))
    .unwrap();
    (composer, payment_pda_account, block)
}

fn empty_block(block: &UiConfirmedBlock) -> UiConfirmedBlock {
    UiConfirmedBlock {
        transactions: Some(vec![]),
        ..block.clone()
    }
}

fn slot_skipped() -> ChainCommunicationError {
    HyperlaneSealevelError::ClientError(Box::new(ClientError::from(ClientErrorKind::RpcError(
        RpcError::RpcResponseError {
            code: JSON_RPC_SERVER_ERROR_SLOT_SKIPPED,
            message: "test".to_owned(),
            data: RpcResponseErrorData::Empty,
        },
    ))))
    .into()
}

#[tokio::test]
async fn test_log_meta_found_in_previous_slot() {
    // given
    let (composer, payment_pda_account, block) = solaxy_payment_composer();
    let tx_slot = block.block_height.unwrap();
    let pda_slot = tx_slot + 1;
    let expected = composer
        .log_meta(block.clone(), U256::zero(), &payment_pda_account, &tx_slot)
        .unwrap();
    let pda_block = empty_block(&block);

    // when
    let log_meta = composer
        .log_meta_at_or_before(
            pda_block,
            U256::zero(),
            &payment_pda_account,
            &pda_slot,
            |slot| {
                assert_eq!(slot, tx_slot);
                async { Ok(block) }
            },
        )
        .await
        .unwrap()
        .unwrap();

    // then: the canonical location is the previous block, not the recorded PDA slot
    assert_eq!(log_meta, expected);
    assert_eq!(log_meta.block_number, tx_slot);
}

#[tokio::test]
async fn test_log_meta_not_in_previous_slot_keeps_fallback() {
    // given
    let (composer, payment_pda_account, block) = solaxy_payment_composer();
    let pda_slot = block.block_height.unwrap() + 1;
    let previous = empty_block(&block);

    // when
    let result = composer
        .log_meta_at_or_before(
            empty_block(&block),
            U256::zero(),
            &payment_pda_account,
            &pda_slot,
            |_| async { Ok(previous) },
        )
        .await
        .unwrap();

    // then
    assert!(matches!(
        result,
        Err(HyperlaneSealevelError::NoTransactions(_))
    ));
}

#[tokio::test]
async fn test_log_meta_previous_slot_unavailable_keeps_fallback() {
    // given
    let (composer, payment_pda_account, block) = solaxy_payment_composer();
    let pda_slot = block.block_height.unwrap() + 1;

    // when
    let result = composer
        .log_meta_at_or_before(
            empty_block(&block),
            U256::zero(),
            &payment_pda_account,
            &pda_slot,
            |_| async { ChainResult::<UiConfirmedBlock>::Err(slot_skipped()) },
        )
        .await
        .unwrap();

    // then
    assert!(matches!(
        result,
        Err(HyperlaneSealevelError::NoTransactions(_))
    ));
}

#[tokio::test]
async fn test_log_meta_previous_slot_transient_error_is_retried() {
    // given
    let (composer, payment_pda_account, block) = solaxy_payment_composer();
    let pda_slot = block.block_height.unwrap() + 1;

    // when
    let result = composer
        .log_meta_at_or_before(
            empty_block(&block),
            U256::zero(),
            &payment_pda_account,
            &pda_slot,
            |_| async {
                ChainResult::<UiConfirmedBlock>::Err(ChainCommunicationError::from_other_str(
                    "connection reset",
                ))
            },
        )
        .await;

    // then
    assert!(result.is_err());
}

#[tokio::test]
async fn test_log_meta_found_at_pda_slot_skips_previous_slot() {
    // given
    let (composer, payment_pda_account, block) = solaxy_payment_composer();
    let pda_slot = block.block_height.unwrap();

    // when
    let log_meta = composer
        .log_meta_at_or_before(
            block,
            U256::zero(),
            &payment_pda_account,
            &pda_slot,
            |_| async { unreachable!("previous block must not be fetched") },
        )
        .await
        .unwrap()
        .unwrap();

    // then
    assert_eq!(log_meta.block_number, pda_slot);
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
