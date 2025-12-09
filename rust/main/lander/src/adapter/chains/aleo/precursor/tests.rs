use uuid::Uuid;

use hyperlane_aleo::AleoTxData;
use hyperlane_core::H512;

use crate::payload::PayloadDetails;
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};

use super::super::transaction::Precursor;
use super::AleoTxPrecursor;

#[test]
fn test_new() {
    let precursor = AleoTxPrecursor::new(
        "test_program.aleo".to_string(),
        "test_function".to_string(),
        vec!["input1".to_string(), "input2".to_string()],
    );

    assert_eq!(precursor.program_id, "test_program.aleo");
    assert_eq!(precursor.function_name, "test_function");
    assert_eq!(precursor.inputs, vec!["input1", "input2"]);
}

#[test]
fn test_from_aleo_tx_data() {
    let tx_data = AleoTxData {
        program_id: "hyperlane.aleo".to_string(),
        function_name: "dispatch".to_string(),
        inputs: vec!["arg1".to_string(), "arg2".to_string(), "arg3".to_string()],
    };

    let precursor = AleoTxPrecursor::from(tx_data);

    assert_eq!(precursor.program_id, "hyperlane.aleo");
    assert_eq!(precursor.function_name, "dispatch");
    assert_eq!(precursor.inputs.len(), 3);
    assert_eq!(precursor.inputs[0], "arg1");
    assert_eq!(precursor.inputs[1], "arg2");
    assert_eq!(precursor.inputs[2], "arg3");
}

#[test]
fn test_clone() {
    let original = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "function".to_string(),
        vec!["input".to_string()],
    );

    let cloned = original.clone();

    assert_eq!(original.program_id, cloned.program_id);
    assert_eq!(original.function_name, cloned.function_name);
    assert_eq!(original.inputs, cloned.inputs);
}

#[test]
fn test_partial_eq() {
    let precursor1 = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "function".to_string(),
        vec!["input".to_string()],
    );

    let precursor2 = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "function".to_string(),
        vec!["input".to_string()],
    );

    assert_eq!(precursor1, precursor2);

    let precursor3 = AleoTxPrecursor::new(
        "different.aleo".to_string(),
        "function".to_string(),
        vec!["input".to_string()],
    );

    assert_ne!(precursor1, precursor3);
}

#[test]
fn test_precursor_trait_read() {
    let precursor = AleoTxPrecursor::new(
        "test.aleo".to_string(),
        "test_fn".to_string(),
        vec!["arg".to_string()],
    );

    let tx = Transaction {
        uuid: TransactionUuid::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Aleo(Box::new(precursor.clone())),
        payload_details: vec![],
        status: TransactionStatus::PendingInclusion,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    };

    let precursor_ref = tx.precursor();
    assert_eq!(precursor_ref.program_id, "test.aleo");
    assert_eq!(precursor_ref.function_name, "test_fn");
    assert_eq!(precursor_ref.inputs, vec!["arg"]);
}

#[test]
fn test_debug_format() {
    let precursor = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "function".to_string(),
        vec!["input1".to_string(), "input2".to_string()],
    );

    let debug_str = format!("{:?}", precursor);

    // Debug format should contain key information but not full input details
    assert!(debug_str.contains("program.aleo"));
    assert!(debug_str.contains("function"));
    assert!(debug_str.contains("inputs_len"));
    assert!(debug_str.contains("2")); // inputs_len should be 2
}

#[test]
fn test_serde_roundtrip() {
    let original = AleoTxPrecursor {
        program_id: "program.aleo".to_string(),
        function_name: "function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    // Serialize
    let serialized = serde_json::to_string(&original).expect("Failed to serialize");

    // Deserialize
    let deserialized: AleoTxPrecursor =
        serde_json::from_str(&serialized).expect("Failed to deserialize");

    // Verify equality
    assert_eq!(original, deserialized);
}

#[test]
fn test_empty_inputs() {
    let precursor = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "no_args_function".to_string(),
        vec![],
    );

    assert_eq!(precursor.inputs.len(), 0);
    assert!(precursor.inputs.is_empty());
}

#[test]
fn test_many_inputs() {
    let inputs: Vec<String> = (0..10).map(|i| format!("input{}", i)).collect();
    let precursor = AleoTxPrecursor::new(
        "program.aleo".to_string(),
        "many_args_function".to_string(),
        inputs.clone(),
    );

    assert_eq!(precursor.inputs.len(), 10);
    assert_eq!(precursor.inputs, inputs);
}
