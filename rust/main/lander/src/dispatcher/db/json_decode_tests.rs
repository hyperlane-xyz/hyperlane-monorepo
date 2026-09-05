use std::fmt::Debug;

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::{Decode, HyperlaneProtocolError, KnownHyperlaneDomain};
use serde::{de::DeserializeOwned, Serialize};

use super::{PayloadDb, TransactionDb};
use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType};
use crate::{payload::FullPayload, tests::test_utils::dummy_tx, transaction::TransactionStatus};

fn assert_json_decode_equivalence<T>(value: &T)
where
    T: Decode + Serialize + DeserializeOwned + PartialEq + Debug,
{
    let bytes = serde_json::to_vec(value).unwrap();
    let json = String::from_utf8(bytes.clone()).unwrap();
    let mut invalid_utf8 = bytes.clone();
    let at = bytes
        .windows(12)
        .position(|s| s == b"probe marker")
        .unwrap();
    invalid_utf8[at] = 255;
    let duplicate_status =
        serde_json::to_string(&serde_json::to_value(value).unwrap()["status"]).unwrap();
    let cases = [
        ("valid", bytes.clone()),
        ("truncated", bytes[..bytes.len() - 1].to_vec()),
        ("whitespace", [bytes.as_slice(), b" \n\t"].concat()),
        ("trailing JSON", [bytes.as_slice(), b"{}"].concat()),
        ("trailing junk", [bytes.as_slice(), b"x"].concat()),
        ("trailing invalid byte", [bytes.as_slice(), &[255]].concat()),
        ("wrong type", b"[]".to_vec()),
        ("empty", vec![]),
        (
            "unknown field",
            [b"{\"unused_probe\":true,".as_slice(), &bytes[1..]].concat(),
        ),
        (
            "duplicate field",
            [
                format!("{{\"status\":{duplicate_status},").as_bytes(),
                &bytes[1..],
            ]
            .concat(),
        ),
        (
            "invalid escape",
            json.replace("probe marker", r"\q").into_bytes(),
        ),
        (
            "invalid surrogate",
            json.replace("probe marker", r"\uD800").into_bytes(),
        ),
        (
            "escaped Unicode",
            json.replace("probe marker", r"line\n\uD83D\uDE00")
                .into_bytes(),
        ),
        ("invalid UTF-8 string", invalid_utf8),
    ];
    for (name, input) in cases {
        let reader = T::read_from(&mut input.as_slice());
        let slice = T::read_from_slice(&input);
        match (reader, slice) {
            (Ok(reader), Ok(slice)) => assert_eq!(reader, slice, "{name}"),
            (
                Err(HyperlaneProtocolError::IoError(reader)),
                Err(HyperlaneProtocolError::IoError(slice)),
            ) => {
                assert_eq!(reader.kind(), slice.kind(), "{name}");
                assert!(reader
                    .to_string()
                    .starts_with("Failed to deserialize. Error: "));
                assert!(slice
                    .to_string()
                    .starts_with("Failed to deserialize. Error: "));
                // Serde's reader and slice parser can report different source
                // columns; preserve acceptance/category rather than exact text.
                let reader = serde_json::from_reader::<_, T>(input.as_slice()).unwrap_err();
                let slice = serde_json::from_slice::<T>(&input).unwrap_err();
                assert_eq!(reader.classify(), slice.classify(), "{name}");
            }
            outcomes => panic!("{name}: inconsistent decode outcomes: {outcomes:?}"),
        }
    }
}

#[test]
fn payload_and_transaction_slice_decoders_match_reader_contracts() {
    for length in [0, 32, 4096] {
        let mut payload = FullPayload::default();
        payload.data = vec![17; length];
        payload.details.metadata = "probe marker".to_owned();
        payload.details.success_criteria = Some(vec![17; length]);
        let transaction = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
        assert_json_decode_equivalence(&payload);
        assert_json_decode_equivalence(&transaction);
        let evm = dummy_evm_tx(
            ExpectedTxType::Eip1559,
            vec![payload],
            TransactionStatus::PendingInclusion,
            ethers::types::H160::zero(),
        );
        assert_json_decode_equivalence(&evm);
    }
}

#[tokio::test]
async fn slice_decoded_records_survive_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let domain = KnownHyperlaneDomain::Arbitrum.into();
    let db = HyperlaneRocksDB::new(&domain, DB::from_path(directory.path()).unwrap());
    let mut payload = FullPayload::random();
    payload.data = vec![17; 4096];
    payload.details.metadata = "Unicode payload 🦀".to_owned();
    let transaction = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    db.store_payload_by_uuid(&payload).await.unwrap();
    db.store_transaction_by_uuid(&transaction).await.unwrap();
    let read_payload = db
        .retrieve_payload_by_uuid(&payload.details.uuid)
        .await
        .unwrap()
        .unwrap();
    let read_transaction = db
        .retrieve_transaction_by_uuid(&transaction.uuid)
        .await
        .unwrap()
        .unwrap();
    drop(db);
    assert_eq!(read_payload, payload);
    assert_eq!(read_transaction, transaction);
    let db = HyperlaneRocksDB::new(&domain, DB::from_path(directory.path()).unwrap());
    assert_eq!(
        db.retrieve_payload_by_uuid(&payload.details.uuid)
            .await
            .unwrap(),
        Some(payload)
    );
    assert_eq!(
        db.retrieve_transaction_by_uuid(&transaction.uuid)
            .await
            .unwrap(),
        Some(transaction)
    );
}
