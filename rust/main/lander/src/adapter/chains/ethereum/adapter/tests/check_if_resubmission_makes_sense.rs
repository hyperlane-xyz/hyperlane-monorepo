use ethers::types::{
    transaction::{eip2718::TypedTransaction, eip2930::AccessList},
    Eip1559TransactionRequest, Eip2930TransactionRequest, TransactionRequest, H160,
};

use crate::{dispatcher::PostInclusionMetricsSource, transaction::VmSpecificTxData};

use crate::LanderError;

use super::super::super::gas_price::GasPrice;
use super::super::super::tests::{dummy_evm_tx, ExpectedTxType};
use super::super::EthereumAdapter;
use super::*;

#[test]
fn first_submission_with_no_gas_price_is_allowed() {
    // Transaction with no gas price set (first submission)
    let tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(result.is_ok());
}

#[test]
fn resubmission_with_higher_gas_price_is_allowed() {
    // Transaction with existing gas price
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is higher
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 2000000000u64.into(),
        max_priority_fee: 2000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(result.is_ok());
}

#[test]
fn resubmission_with_same_gas_price_is_rejected_for_included() {
    // Transaction with existing gas price in Included status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxAlreadyExists)));
}

#[test]
fn resubmission_with_same_gas_price_is_rejected_for_pending_inclusion() {
    // Transaction with existing gas price in PendingInclusion status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxGasCapReached)));
}

#[test]
fn resubmission_with_same_gas_price_is_rejected_for_mempool() {
    // Transaction with existing gas price in Mempool status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Mempool,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxAlreadyExists)));
}

#[test]
fn resubmission_with_same_gas_price_is_rejected_for_finalized() {
    // Transaction with existing gas price in Finalized status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Finalized,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxAlreadyExists)));
}

#[test]
fn resubmission_with_same_gas_price_is_rejected_for_dropped() {
    use crate::transaction::DropReason;

    // Transaction with existing gas price in Dropped status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Dropped(DropReason::DroppedByChain),
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(
        result,
        Err(LanderError::TxDropped(DropReason::DroppedByChain))
    ));
}

#[test]
fn legacy_tx_resubmission_with_higher_gas_price_is_allowed() {
    // Transaction with existing legacy gas price
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Legacy(TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            gas_price: Some(1000000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is higher
    let new_gas_price = GasPrice::NonEip1559 {
        gas_price: 2000000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(result.is_ok());
}

#[test]
fn legacy_tx_resubmission_with_same_gas_price_is_rejected_for_included() {
    // Transaction with existing legacy gas price in Included status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Legacy(TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            gas_price: Some(1000000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::NonEip1559 {
        gas_price: 1000000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxAlreadyExists)));
}

#[test]
fn legacy_tx_resubmission_with_same_gas_price_is_rejected_for_pending_inclusion() {
    // Transaction with existing legacy gas price in PendingInclusion status
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Legacy(TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            gas_price: Some(1000000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price is the same
    let new_gas_price = GasPrice::NonEip1559 {
        gas_price: 1000000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(matches!(result, Err(LanderError::TxGasCapReached)));
}

#[test]
fn eip1559_resubmission_with_only_max_fee_increased_is_allowed() {
    // Transaction with existing gas price
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price: only max_fee increased, priority fee the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 2000000000u64.into(),
        max_priority_fee: 1000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(result.is_ok());
}

#[test]
fn eip1559_resubmission_with_only_priority_fee_increased_is_allowed() {
    // Transaction with existing gas price
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // Set existing gas price
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(1000000.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    // New gas price: only priority fee increased, max_fee the same
    let new_gas_price = GasPrice::Eip1559 {
        max_fee: 1000000000u64.into(),
        max_priority_fee: 2000000u64.into(),
    };

    let result = EthereumAdapter::check_if_resubmission_makes_sense(&tx, &new_gas_price);
    assert!(result.is_ok());
}
