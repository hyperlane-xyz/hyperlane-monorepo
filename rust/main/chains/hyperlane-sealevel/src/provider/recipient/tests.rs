use std::fs;
use std::path::PathBuf;

use rstest::rstest;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, UiInstruction, UiMessage, UiParsedInstruction,
    UiParsedMessage, UiPartiallyDecodedInstruction, UiTransaction,
};

use hyperlane_core::H512;

use crate::provider::recipient::RecipientProvider;
use crate::provider::transaction::txn;
use crate::utils::decode_h256;

#[rstest]
#[case(
    "solana_complex_transaction_including_token_transfer.json",
    "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi",
    "3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm"
)]
#[case(
    "eclipse_complex_transaction_including_token_transfer.json",
    "EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y",
    "FJu4E1BDYKVg7aTWdwATZRUvytJZ8ZZ2gQuvPfMWAz9y"
)]
fn test_identify_recipient_in_complex_transaction(
    #[case] transaction_file: &str,
    #[case] mailbox: &str,
    #[case] warp_route: &str,
) {
    // given
    let json = read_json(transaction_file);
    let transaction = transaction(&json);
    let mailbox_address = decode_h256(mailbox).unwrap();
    let provider = RecipientProvider::new(&[mailbox_address]);

    let warp_route_address = decode_h256(warp_route).unwrap();

    // when
    let recipient = provider.recipient(&H512::zero(), &transaction);

    // then
    assert!(recipient.is_ok());
    assert_eq!(recipient.unwrap(), warp_route_address);
}

#[test]
fn test_identify_recipient_in_igp_transaction() {
    // given
    let transaction = transaction_with_igp();
    let igp_master = "DrFtxirPPsfdY4HQiNZj2A9o4Ux7JaL3gELANgAoihhp";
    let igp_master_address = decode_h256(igp_master).unwrap();
    let provider = RecipientProvider::new(&[igp_master_address]);

    let igp_address = decode_h256("GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U").unwrap();

    // when
    let recipient = provider.recipient(&H512::zero(), &transaction);

    // then
    assert!(recipient.is_ok());
    assert_eq!(recipient.unwrap(), igp_address);
}

#[test]
fn test_identify_recipient_in_alternative_igp_transaction() {
    // given
    let transaction = transaction_with_alternative_igp();
    let igp_master = "DrFtxirPPsfdY4HQiNZj2A9o4Ux7JaL3gELANgAoihhp";
    let igp_master_address = decode_h256(igp_master).unwrap();
    let provider = RecipientProvider::new(&[igp_master_address]);

    let igp_address = decode_h256("GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U").unwrap();

    // when
    let recipient = provider.recipient(&H512::zero(), &transaction);

    // then
    assert!(recipient.is_ok());
    assert_eq!(recipient.unwrap(), igp_address);
}

#[test]
fn test_failure_to_identify_recipient_transaction_with_native() {
    // given
    let transaction = transaction_with_native_programs_only();
    let igp_master = "DrFtxirPPsfdY4HQiNZj2A9o4Ux7JaL3gELANgAoihhp";
    let igp_master_address = decode_h256(igp_master).unwrap();
    let provider = RecipientProvider::new(&[igp_master_address]);

    // when
    let recipient = provider.recipient(&H512::zero(), &transaction);

    // then
    assert!(recipient.is_err());
}

fn read_json(path: &str) -> String {
    let relative = PathBuf::new().join("src/provider/recipient/").join(path);
    let absolute = fs::canonicalize(relative).expect("cannot find path");
    fs::read_to_string(absolute).expect("should have been able to read the file")
}

fn transaction(json: &str) -> UiTransaction {
    let transaction =
        serde_json::from_str::<EncodedConfirmedTransactionWithStatusMeta>(json).unwrap();
    txn(&transaction.transaction).unwrap().clone()
}

fn transaction_with_igp() -> UiTransaction {
    UiTransaction {
        signatures: vec!["3XHQhCbhcLrDq7vqtdDSMZxQ2PEuk3Wz3JoahMYL332Tq1VA8oRh2X1NCSArG2M7Wq2ZnG6BWwGxQMoEVhvD8wLd".to_string(), "3N6s1P1KkmkHohH5LHmpWS8ZvTwtp8yCUnpnMv8jGP3Z9a2DioLXzzSNNwfvVitRFCBHoKTzz64FQsG1aWK13iNk".to_string()],
        message: UiMessage::Parsed(
            UiParsedMessage {
                account_keys: vec![],
                recent_blockhash: "".to_string(),
                instructions: vec![
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(UiPartiallyDecodedInstruction {
                        program_id: "ComputeBudget111111111111111111111111111111".to_string(),
                        accounts: vec![],
                        data: "K1FDJ7".to_string(),
                    })),
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(UiPartiallyDecodedInstruction {
                        program_id: "GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U".to_string(),
                        accounts: vec!["11111111111111111111111111111111".to_string(), "E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty".to_string(), "HBB1MxTeuRGb3C4bfXLQbu9z2Pn2LTXVQX53Hy7uyeof".to_string(), "APrjTrTeUqyQgg7n52YrQkULUa4AniaVKkxhgTXNugSg".to_string(), "GV2Qj26E43X9zLhaR9jgs44yZnmf1UPqJNyd435ca7L1".to_string(), "DrFtxirPPsfdY4HQiNZj2A9o4Ux7JaL3gELANgAoihhp".to_string(), "EBEZGxTABcfHgPH1vZZc9BnFWHjne4nzqApZZxGTCgsn".to_string()],
                        data: "6bsyHSvcBqJsshiyP1v8RNvNsiwPqsLr4LMEv8TQ2GVeoJM6uYWXFFujxHdts".to_string(),
                    }))
                ],
                address_table_lookups: None,
            }
        ),
    }
}

fn transaction_with_alternative_igp() -> UiTransaction {
    UiTransaction {
        signatures: vec!["3XHQhCbhcLrDq7vqtdDSMZxQ2PEuk3Wz3JoahMYL332Tq1VA8oRh2X1NCSArG2M7Wq2ZnG6BWwGxQMoEVhvD8wLd".to_string(), "3N6s1P1KkmkHohH5LHmpWS8ZvTwtp8yCUnpnMv8jGP3Z9a2DioLXzzSNNwfvVitRFCBHoKTzz64FQsG1aWK13iNk".to_string()],
        message: UiMessage::Parsed(
            UiParsedMessage {
                account_keys: vec![],
                recent_blockhash: "".to_string(),
                instructions: vec![
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(UiPartiallyDecodedInstruction {
                        program_id: "ComputeBudget111111111111111111111111111111".to_string(),
                        accounts: vec![],
                        data: "K1FDJ7".to_string(),
                    })),
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(UiPartiallyDecodedInstruction {
                        program_id: "GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U".to_string(),
                        accounts: vec!["11111111111111111111111111111111".to_string(), "E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty".to_string(), "HBB1MxTeuRGb3C4bfXLQbu9z2Pn2LTXVQX53Hy7uyeof".to_string(), "83fgCBnDRTU3ke1L9RGxkYRhT48DS8csJ6U1QDRLU96h".to_string(), "5MRsEobfsbZKrrZnE6bGCCGPLXzF56x9jJzmQ6DMDe7a".to_string(), "8EniU8dQaGQ3HWWtT77V7hrksheygvEu6TtzJ3pX1nKM".to_string(), "3A83CEaaEQtgvzdfppEt6arFY1vgkpaf9rd8Ynfoyit8".to_string()],
                        data: "6bsyHSvcBqJsshiyP1v8RNvNsiwPqsLr4LMEv8TQ2GVeoJM6uYWXFFujxHdts".to_string(),
                    }))
                ],
                address_table_lookups: None,
            }
        ),
    }
}

fn transaction_with_native_programs_only() -> UiTransaction {
    UiTransaction {
        signatures: vec!["3XHQhCbhcLrDq7vqtdDSMZxQ2PEuk3Wz3JoahMYL332Tq1VA8oRh2X1NCSArG2M7Wq2ZnG6BWwGxQMoEVhvD8wLd".to_string(), "3N6s1P1KkmkHohH5LHmpWS8ZvTwtp8yCUnpnMv8jGP3Z9a2DioLXzzSNNwfvVitRFCBHoKTzz64FQsG1aWK13iNk".to_string()],
        message: UiMessage::Parsed(
            UiParsedMessage {
                account_keys: vec![],
                recent_blockhash: "".to_string(),
                instructions: vec![
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(UiPartiallyDecodedInstruction {
                        program_id: "ComputeBudget111111111111111111111111111111".to_string(),
                        accounts: vec![],
                        data: "K1FDJ7".to_string(),
                    }))
                ],
                address_table_lookups: None,
            }
        ),
    }
}
