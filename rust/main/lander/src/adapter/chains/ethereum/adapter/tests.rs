use std::{sync::Arc, time::Duration};

use ethers::types::{
    transaction::{eip2718::TypedTransaction, eip2930::AccessList},
    Address, Eip1559TransactionRequest, Eip2930TransactionRequest, TransactionRequest, H160,
};
use hyperlane_core::U256;
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::{
    adapter::chains::ethereum::{
        tests::{make_nonce_updater, make_tx},
        EthereumAdapter, EthereumAdapterMetrics, NonceManager, NonceManagerState, NonceUpdater,
        Precursor,
    },
    dispatcher::PostInclusionMetricsSource,
    tests::test_utils::tmp_dbs,
    transaction::{TransactionUuid, VmSpecificTxData},
    TransactionStatus,
};

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

#[tracing_test::traced_test]
#[tokio::test]
async fn test_load_nonce_from_db() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    let nonce_updater = make_nonce_updater(address, state.clone());
    let manager = NonceManager {
        address,
        state,
        nonce_updater,
    };

    let uuid = TransactionUuid::random();

    let expected_nonce = U256::from(100);
    manager
        .state
        .set_tracked_tx_uuid(&expected_nonce, &uuid)
        .await
        .expect("Failed to store nonce and uuid");

    // From address does not match manager address
    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    EthereumAdapter::load_nonce_from_db(&manager, &mut tx)
        .await
        .expect("Failed to load nonce from db");

    assert_eq!(
        tx.precursor().tx.nonce().cloned().map(|v| v.into()),
        Some(expected_nonce)
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_load_nonce_from_db_does_not_exist() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    let nonce_updater = make_nonce_updater(address, state.clone());
    let manager = NonceManager {
        address,
        state,
        nonce_updater,
    };

    let uuid = TransactionUuid::random();

    let expected_nonce = U256::from(1000);
    // From address does not match manager address
    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(U256::from(1000)),
        Some(address),
    );

    EthereumAdapter::load_nonce_from_db(&manager, &mut tx)
        .await
        .expect("Failed to load nonce from db");

    assert_eq!(
        tx.precursor().tx.nonce().cloned().map(|v| v.into()),
        Some(expected_nonce)
    );
}
