//! Real production Encode/Decode implementations, including base storage types.
#[path = "../../../../rust/main/hyperlane-base/src/db/storage_types.rs"]
mod storage_types;
use hyperlane_core::{
    identifiers::UniqueIdentifier, BackwardCursorProgress, Decode, Encode, GasPaymentKey,
    HyperlaneIdentifier, Indexed, InterchainGasPayment, InterchainGasPaymentMeta,
    MerkleTreeInsertion, PendingOperationStatus, ReprepareReason, H160, H256, H512, U256,
};
use serde_json::{json, Value};
use storage_types::{
    InterchainGasExpenditureData, InterchainGasPaymentData, PendingMessageRetryState,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn hex(bytes: &[u8]) -> Vec<String> {
    let text: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    text.as_bytes()
        .chunks(32)
        .map(|v| String::from_utf8_lossy(v).into_owned())
        .collect()
}
fn emit<T: Encode>(kind: &str, name: &str, value: &T, fields: Value) {
    println!(
        "{}",
        json!({"kind":kind,"name":name,"wire_hex_chunks":hex(&value.to_vec()),"fields":fields,"valid":true})
    );
}
fn emit_json<T: Encode>(kind: &str, name: &str, value: &T) -> Result<()> {
    let encoded = value.to_vec();
    let text = std::str::from_utf8(&encoded)?;
    let chunks: Vec<String> = text
        .chars()
        .collect::<Vec<_>>()
        .chunks(32)
        .map(|v| v.iter().collect())
        .collect();
    println!(
        "{}",
        json!({"kind":kind,"name":name,"wire_utf8_chunks":chunks,"valid":true})
    );
    Ok(())
}
fn main() -> Result<()> {
    for v in [0u32, 1, 0x01020304, u32::MAX] {
        emit("u32", &v.to_string(), &v, json!({"value":v.to_string()}));
    }
    for v in [0u64, 1, 0x0102030405060708, u64::MAX] {
        emit("u64", &v.to_string(), &v, json!({"value":v.to_string()}));
    }
    for v in [
        U256::zero(),
        U256::one(),
        U256::from(0x0102030405060708u64),
        U256::MAX,
    ] {
        emit("u256", &v.to_string(), &v, json!({"value":v.to_string()}));
    }
    for v in [false, true] {
        emit("bool", &v.to_string(), &v, json!({"value":v}));
    }
    emit(
        "hash16",
        "uuid",
        &serde_json::from_str::<UniqueIdentifier>("\"00112233-4455-6677-8899-aabbccddeeff\"")?,
        Value::Null,
    );
    emit("hash20", "H160", &H160::repeat_byte(0x11), Value::Null);
    emit("hash32", "H256", &H256::repeat_byte(0x22), Value::Null);
    emit(
        "hash32",
        "HyperlaneIdentifier",
        &HyperlaneIdentifier::from(H160::repeat_byte(0x33)),
        Value::Null,
    );
    emit("hash64", "H512", &H512::repeat_byte(0x44), Value::Null);
    let key = GasPaymentKey {
        message_id: H256::repeat_byte(0x11),
        destination: 0x01020304,
    };
    emit(
        "GasPaymentKey",
        "gas_key",
        &key,
        json!({"message_id":hex(key.message_id.as_bytes()),"destination":key.destination.to_string()}),
    );
    let meta = InterchainGasPaymentMeta {
        transaction_id: H512::repeat_byte(0x22),
        log_index: 0x0102030405060708,
    };
    emit(
        "GasPaymentMeta",
        "gas_meta",
        &meta,
        json!({"transaction_id":hex(meta.transaction_id.as_bytes()),"log_index":meta.log_index.to_string()}),
    );
    let gas = InterchainGasPayment {
        message_id: key.message_id,
        destination: key.destination,
        payment: U256::from(123456789),
        gas_amount: U256::MAX,
    };
    emit(
        "GasPayment",
        "gas_payment",
        &gas,
        json!({"message_id":hex(gas.message_id.as_bytes()),"destination":gas.destination.to_string(),"payment":gas.payment.to_string(),"gas_amount":gas.gas_amount.to_string()}),
    );
    let data = InterchainGasPaymentData {
        payment: gas.payment,
        gas_amount: gas.gas_amount,
    };
    emit(
        "GasPaymentData",
        "gas_payment_data",
        &data,
        json!({"payment":data.payment.to_string(),"gas_amount":data.gas_amount.to_string()}),
    );
    let expenditure = InterchainGasExpenditureData {
        tokens_used: U256::MAX,
        gas_used: U256::from(987654321),
    };
    emit(
        "GasExpenditureData",
        "gas_expenditure",
        &expenditure,
        json!({"tokens_used":expenditure.tokens_used.to_string(),"gas_used":expenditure.gas_used.to_string()}),
    );
    let insertion = MerkleTreeInsertion::new(0x01020304, H256::repeat_byte(0x55));
    emit(
        "MerkleInsertion",
        "insertion",
        &insertion,
        json!({"leaf_index":insertion.index().to_string(),"message_id":hex(insertion.message_id().as_bytes())}),
    );
    let cursor = BackwardCursorProgress {
        sequence: 123,
        block: u32::MAX,
    };
    emit(
        "BackwardCursor",
        "cursor",
        &cursor,
        json!({"sequence":cursor.sequence.to_string(),"block":cursor.block.to_string()}),
    );
    for sequence in [None, Some(0), Some(u32::MAX)] {
        let mut indexed = Indexed::new(insertion);
        if let Some(sequence) = sequence {
            indexed = indexed.with_sequence(sequence);
        }
        emit(
            "IndexedMerkleInsertion",
            &format!("{sequence:?}"),
            &indexed,
            json!({"sequence":sequence,"leaf_index":insertion.index().to_string(),"message_id":hex(insertion.message_id().as_bytes())}),
        );
    }
    for count in [0, 1, 3] {
        let ids: Vec<UniqueIdentifier> = (0..count)
            .map(|_| serde_json::from_str("\"00112233-4455-6677-8899-aabbccddeeff\""))
            .collect::<std::result::Result<_, _>>()?;
        emit(
            "UuidList",
            &format!("length_{count}"),
            &ids,
            json!({"count":count}),
        );
    }
    for status in [
        "\"FirstPrepareAttempt\"",
        "\"ReadyToSubmit\"",
        "{\"Confirm\":\"SubmittedBySelf\"}",
        "{\"Confirm\":\"AlreadySubmitted\"}",
        "{\"Confirm\":\"ErrorConfirmingDelivery\"}",
        "{\"Confirm\":\"ErrorRecordingProcessSuccess\"}",
    ] {
        let parsed: PendingOperationStatus = serde_json::from_str(status)?;
        emit_json("Status", status, &parsed)?;
    }
    let reasons = [
        "Manual",
        "ErrorCheckingDeliveryStatus",
        "ErrorCheckingIfRecipientIsContract",
        "ErrorFetchingIsmAddress",
        "ErrorGettingMetadataBuilder",
        "ErrorSubmitting",
        "ErrorBuildingMetadata",
        "CouldNotFetchMetadata",
        "ErrorEstimatingGas",
        "ErrorCheckingGasRequirement",
        "GasPaymentRequirementNotMet",
        "GasPaymentNotFound",
        "ExceedsMaxGasLimit",
        "RevertedOrReorged",
        "MessageMetadataRefused",
        "ErrorCreatingPayload",
        "ErrorStoringPayloadUuidsByMessageId",
        "ErrorRetrievingPayloadUuids",
        "ErrorRetrievingPayloadStatus",
        "ErrorPersistingTerminalMessage",
        "ErrorCreatingPayloadSuccessCriteria",
        "AwaitingValidatorSignatures",
        "AwaitingIcaReveal",
        "ErrorFetchingOriginTxSender",
    ];
    for reason in reasons {
        let parsed: ReprepareReason = serde_json::from_value(json!(reason))?;
        emit_json(
            "Status",
            reason,
            &PendingOperationStatus::Retry(parsed.clone()),
        )?;
        emit_json(
            "RetryState",
            reason,
            &PendingMessageRetryState::new(42, Some(u64::MAX), Some(1000), Some(parsed)),
        )?;
    }
    for report in ["AmountBelowMinimum", "MalformedMessage", "ZeroAmount"] {
        let reason: ReprepareReason = serde_json::from_value(json!({"ApplicationReport":report}))?;
        emit_json("Status", report, &PendingOperationStatus::Retry(reason))?;
    }
    emit_json(
        "RetryState",
        "no_deadline",
        &PendingMessageRetryState::new(0, None, None, None),
    )?;
    for raw in [
        "{\"version\":2,\"retry_count\":0}",
        "{\"version\":1,\"retry_count\":0,\"next_attempt_at_millis\":1}",
        "{\"version\":1,\"retry_count\":0,\"reason\":\"Unknown\"}",
    ] {
        assert!(PendingMessageRetryState::read_from(&mut raw.as_bytes()).is_err());
        println!(
            "{}",
            json!({"kind":"RetryState","name":"invalid","wire_utf8_chunks":raw.chars().collect::<Vec<_>>().chunks(32).map(|v|v.iter().collect::<String>()).collect::<Vec<_>>(),"valid":false})
        );
    }
    Ok(())
}
