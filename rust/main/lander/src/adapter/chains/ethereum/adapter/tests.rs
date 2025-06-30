use ethers::types::{
    transaction::{eip2718::TypedTransaction, eip2930::AccessList},
    Eip1559TransactionRequest, Eip2930TransactionRequest, TransactionRequest, H160,
};

use crate::{dispatcher::PostInclusionMetricsSource, transaction::VmSpecificTxData};

use super::super::tests::{dummy_evm_tx, ExpectedTxType};

#[test]
fn vm_specific_metrics_are_extracted_correctly_legacy() {
    use super::EthereumAdapter;
    use crate::transaction::Transaction;

    let mut evm_tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
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

    let expected_post_inclusion_metrics_source = PostInclusionMetricsSource {
        gas_price: Some(1000000000),
        priority_fee: None,
        gas_limit: Some(21000),
    };

    let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
    assert_eq!(metrics_source, expected_post_inclusion_metrics_source);
}

#[test]
fn vm_specific_metrics_are_extracted_correctly_eip1559() {
    use super::EthereumAdapter;
    use crate::transaction::Transaction;

    let mut evm_tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(H160::random()),
            to: Some(H160::random().into()),
            nonce: Some(0.into()),
            gas: Some(21000.into()),
            max_fee_per_gas: Some(1000000000.into()),
            max_priority_fee_per_gas: Some(22222.into()),
            value: Some(1.into()),
            ..Default::default()
        });
    }

    let expected_post_inclusion_metrics_source = PostInclusionMetricsSource {
        gas_price: Some(1000000000),
        priority_fee: Some(22222),
        gas_limit: Some(21000),
    };
    let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
    assert_eq!(metrics_source, expected_post_inclusion_metrics_source);
}

#[test]
fn vm_specific_metrics_are_extracted_correctly_eip2930() {
    use super::EthereumAdapter;
    use crate::transaction::Transaction;

    let mut evm_tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip2930(Eip2930TransactionRequest {
            tx: TransactionRequest {
                from: Some(H160::random()),
                to: Some(H160::random().into()),
                nonce: Some(0.into()),
                gas: Some(21000.into()),
                gas_price: Some(1000000000.into()),
                value: Some(1.into()),
                ..Default::default()
            },
            access_list: AccessList::default(),
        });
    }

    let expected_post_inclusion_metrics_source = PostInclusionMetricsSource {
        gas_price: Some(1000000000),
        priority_fee: None,
        gas_limit: Some(21000), // Default gas limit for EIP-2930 transactions
    };
    let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
    assert_eq!(metrics_source, expected_post_inclusion_metrics_source);
}
