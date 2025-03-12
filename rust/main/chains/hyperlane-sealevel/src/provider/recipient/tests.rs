use std::fs;
use std::path::PathBuf;

use rstest::rstest;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, EncodedTransactionWithStatusMeta,
};

use hyperlane_core::H512;

use crate::provider::recipient::RecipientProvider;
use crate::utils::decode_h256;

#[rstest]
#[case(
    "solana_complex_transaction_including_token_transfer.json",
    "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi"
)]
#[case(
    "eclipse_complex_transaction_including_token_transfer.json",
    "EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y"
)]
fn test_identify_recipient_in_complex_transaction(
    #[case] transaction_file: &str,
    #[case] mailbox: &str,
) {
    // given
    let transaction = transaction(&read_json(transaction_file));
    let mailbox_address = decode_h256(mailbox).unwrap();
    let provider = RecipientProvider::new(mailbox_address);

    // when
    let recipient = provider.recipient(&H512::zero(), &transaction);

    // then
    assert!(recipient.is_ok());
    assert_eq!(recipient.unwrap(), mailbox_address);
}

fn read_json(path: &str) -> String {
    let relative = PathBuf::new().join("src/provider/recipient/").join(path);
    let absolute = fs::canonicalize(relative).expect("cannot find path");
    fs::read_to_string(absolute).expect("should have been able to read the file")
}

fn transaction(json: &str) -> EncodedTransactionWithStatusMeta {
    let txn = serde_json::from_str::<EncodedConfirmedTransactionWithStatusMeta>(json).unwrap();
    txn.transaction
}
