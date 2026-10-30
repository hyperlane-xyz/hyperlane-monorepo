use std::{sync::Arc, time::Duration};

use ethers::{
    abi::{AbiParser, Function},
    providers::Provider,
    types::{
        transaction::eip2718::TypedTransaction, Eip1559TransactionRequest, H160, U256 as EthersU256,
    },
};
use hyperlane_core::{
    ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox, Metadata,
    H256, U256,
};
use hyperlane_ethereum::{ConnectionConf, EthereumMailbox, RpcConnectionConf};

use crate::{
    adapter::{
        chains::ethereum::{tests::MockEvmProvider, transaction::Precursor},
        AdaptsChain,
    },
    tests::{
        evm::test_utils::{mock_ethereum_adapter, mock_get_block},
        test_utils::tmp_dbs,
    },
    FullPayload,
};

async fn paid_payload(gas: u64, domain: HyperlaneDomain) -> FullPayload {
    let (provider, _) = Provider::mocked();
    let connection = ConnectionConf {
        rpc_connection: RpcConnectionConf::Http {
            url: "http://127.0.0.1:8545".parse::<url::Url>().unwrap().into(),
        },
        transaction_overrides: Default::default(),
        op_submission_config: Default::default(),
        consider_null_transaction_receipt: false,
        fallback_hedge: None,
        mev_submission: None,
    };
    let mailbox = EthereumMailbox::new(
        Arc::new(provider),
        &connection,
        &ContractLocator {
            domain: &domain,
            address: H256::zero(),
        },
    );
    let mut payload = FullPayload::random();
    payload.data = mailbox
        .process_calldata(&HyperlaneMessage::default(), &Metadata::new(vec![]))
        .await
        .unwrap();
    payload.gas_limit = gas.into();
    payload
}

fn empty_batch() -> (TypedTransaction, Function) {
    (
        Eip1559TransactionRequest::default().into(),
        AbiParser::default()
            .parse_function("function aggregate3(bytes)")
            .unwrap(),
    )
}

#[tokio::test]
async fn single_delivery_preserves_paid_gas_and_buffers_larger_estimates() {
    for (domain, paid, estimate, expected) in [
        (
            KnownHyperlaneDomain::Arbitrum,
            1_011_344u64,
            551_905u64,
            1_187_478u64,
        ),
        (
            KnownHyperlaneDomain::Arbitrum,
            927_213,
            1_200_000,
            1_395_000,
        ),
        (KnownHyperlaneDomain::Arbitrum, 927_213, 549_015, 1_094_934),
        (KnownHyperlaneDomain::Arbitrum, 0, 100_000, 185_000),
        (KnownHyperlaneDomain::Ethereum, 0, 100_000, 175_000),
        (
            KnownHyperlaneDomain::Ethereum,
            1_011_344,
            551_905,
            1_086_344,
        ),
        (
            KnownHyperlaneDomain::Ethereum,
            927_213,
            1_200_000,
            1_275_000,
        ),
    ] {
        let (payload_db, tx_db, nonce_db) = tmp_dbs();
        let mut provider = MockEvmProvider::new();
        provider
            .expect_estimate_gas_limit()
            .once()
            .withf(|tx, _| tx.gas().is_none())
            .returning(move |_, _| Ok(estimate.into()));
        mock_get_block(&mut provider);
        let mut adapter = mock_ethereum_adapter(
            provider,
            payload_db,
            tx_db,
            nonce_db,
            H160::zero(),
            Duration::ZERO,
            Duration::ZERO,
        );
        adapter.domain = domain.into();
        let mut built = adapter
            .build_transactions(&[paid_payload(paid, adapter.domain.clone()).await])
            .await;
        let mut tx = built[0].maybe_tx.take().unwrap();
        adapter.estimate_tx(&mut tx).await.unwrap();
        assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(expected)));

        // A retry reuses the final limit rather than estimating and buffering again.
        tx.submission_attempts = 2;
        adapter.estimate_tx(&mut tx).await.unwrap();
        assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(expected)));
    }
}

#[tokio::test]
async fn batched_delivery_preserves_paid_floors_or_falls_back_to_singles() {
    for (configured_cap, block_cap, split) in [
        (None, 30_000_000u64, false),
        (Some(1_200_000u64), 30_000_000, true),
        (None, 1_500_000, true),
        // The individual budgets fit, but Multicall overhead does not.
        (Some(1_940_000), 30_000_000, true),
        // The unbuffered batch fits, but its submission buffer does not.
        (Some(2_000_000), 30_000_000, true),
        (None, 2_000_000, true),
    ] {
        let (payload_db, tx_db, nonce_db) = tmp_dbs();
        let mut provider = MockEvmProvider::new();
        provider
            .expect_batch()
            .times(usize::from(!split))
            .returning(|_, _, _, _| Ok(empty_batch()));
        provider
            .expect_estimate_gas_limit()
            .times(if split { 2 } else { 4 })
            .withf(|tx, _| tx.gas().is_none())
            .returning(|_, _| Ok(U256::from(551_905)));
        provider.expect_get_block().returning(move |_| {
            Ok(Some(ethers::types::Block {
                gas_limit: block_cap.into(),
                ..Default::default()
            }))
        });
        provider
            .expect_estimate_batch()
            .times(if split { 0 } else { 2 })
            .withf(|(tx, _), precursors| {
                assert!(tx.gas().is_none());
                let gas: Vec<_> = precursors.iter().map(|(tx, _)| tx.gas().copied()).collect();
                gas == vec![
                    Some(EthersU256::from(1_011_344)),
                    Some(EthersU256::from(927_213)),
                ]
            })
            .returning(|_, precursors| {
                Ok(precursors.iter().fold(U256::zero(), |sum, (tx, _)| {
                    sum + U256::from(*tx.gas().unwrap())
                }) + U256::from(7_000))
            });
        let payloads = vec![
            paid_payload(1_011_344, KnownHyperlaneDomain::Arbitrum.into()).await,
            paid_payload(927_213, KnownHyperlaneDomain::Arbitrum.into()).await,
        ];
        for payload in &payloads {
            payload_db.store_payload_by_uuid(payload).await.unwrap();
        }
        let mut adapter = mock_ethereum_adapter(
            provider,
            payload_db,
            tx_db,
            nonce_db,
            H160::zero(),
            Duration::ZERO,
            Duration::ZERO,
        );
        adapter.transaction_overrides.gas_limit_cap = configured_cap.map(U256::from);
        let mut built = adapter.build_transactions(&payloads).await;
        assert_eq!(built.len(), if split { 2 } else { 1 });
        for (index, built) in built.iter_mut().enumerate() {
            let mut tx = built.maybe_tx.take().unwrap();
            adapter.estimate_tx(&mut tx).await.unwrap();
            let expected = if split {
                [1_187_478u64, 1_094_934][index]
            } else {
                2_215_112
            };
            assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(expected)));
        }
        if split {
            assert_eq!(
                adapter
                    .metrics()
                    .get_batched_transactions()
                    .with_label_values(&["test1", "failed"])
                    .get(),
                2
            );
        }
    }
}

#[tokio::test]
async fn failed_batch_estimation_falls_back_to_singles() {
    for (configured_cap, block_cap, paid, rpc_error) in [
        (Some(1_000_000u64), 30_000_000u64, 100_000u64, false),
        (None, 1_500_000, 100_000, false),
        (Some(1_000_000), 30_000_000, 0, false),
        (None, 30_000_000, 100_000, true),
    ] {
        let (payload_db, tx_db, nonce_db) = tmp_dbs();
        let mut provider = MockEvmProvider::new();
        provider
            .expect_batch()
            .once()
            .returning(|_, _, _, _| Ok(empty_batch()));
        provider.expect_get_block().returning(move |_| {
            Ok(Some(ethers::types::Block {
                gas_limit: block_cap.into(),
                ..Default::default()
            }))
        });
        provider
            .expect_estimate_gas_limit()
            .returning(|_, _| Ok(400_000.into()));
        provider
            .expect_estimate_batch()
            .once()
            .returning(move |_, _| {
                if rpc_error {
                    Err(hyperlane_core::ChainCommunicationError::CustomError(
                        "batch exceeds RPC gas limit".into(),
                    ))
                } else {
                    Ok(1_800_000.into())
                }
            });
        let payloads = vec![
            paid_payload(paid, KnownHyperlaneDomain::Ethereum.into()).await,
            paid_payload(paid, KnownHyperlaneDomain::Ethereum.into()).await,
        ];
        for payload in &payloads {
            payload_db.store_payload_by_uuid(payload).await.unwrap();
        }
        let mut adapter = mock_ethereum_adapter(
            provider,
            payload_db,
            tx_db,
            nonce_db,
            H160::zero(),
            Duration::ZERO,
            Duration::ZERO,
        );
        adapter.transaction_overrides.gas_limit_cap = configured_cap.map(U256::from);
        let mut built = adapter.build_transactions(&payloads).await;
        assert_eq!(built.len(), 2);
        for (built, payload) in built.iter_mut().zip(&payloads) {
            let mut single = built.maybe_tx.take().unwrap();
            assert_eq!(single.payload_details, vec![payload.details.clone()]);
            adapter.estimate_tx(&mut single).await.unwrap();
            assert_eq!(
                single.precursor().tx.gas(),
                Some(&EthersU256::from(515_000))
            );
        }
    }
}

#[tokio::test]
async fn batch_rebuilt_as_single_delivery_keeps_the_paid_budget() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();
    provider
        .expect_batch()
        .once()
        .returning(|_, _, _, _| Ok(empty_batch()));
    provider
        .expect_simulate_batch()
        .once()
        .returning(|_| Ok((vec![1], vec![(0, "reverted".into())])));
    provider
        .expect_estimate_gas_limit()
        .times(3)
        .withf(|tx, _| tx.gas().is_none())
        .returning(|_, _| Ok(100_000.into()));
    provider
        .expect_estimate_batch()
        .once()
        .returning(|_, _| Ok(2_000_000.into()));
    mock_get_block(&mut provider);
    let payloads = vec![
        paid_payload(1_011_344, KnownHyperlaneDomain::Arbitrum.into()).await,
        paid_payload(927_213, KnownHyperlaneDomain::Arbitrum.into()).await,
    ];
    for payload in &payloads {
        payload_db.store_payload_by_uuid(payload).await.unwrap();
    }
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db,
        nonce_db,
        H160::zero(),
        Duration::ZERO,
        Duration::ZERO,
    );
    let mut built = adapter.build_transactions(&payloads).await;
    let mut tx = built[0].maybe_tx.take().unwrap();
    tx.submission_attempts = 1;

    let rejected = adapter.simulate_tx(&mut tx).await.unwrap();
    assert_eq!(rejected, vec![payloads[0].details.clone()]);
    assert_eq!(tx.payload_details, vec![payloads[1].details.clone()]);
    adapter.estimate_tx(&mut tx).await.unwrap();
    assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(1_094_934)));
}

#[tokio::test]
async fn batch_buffers_larger_estimates_once_and_preserves_zero_floor_behavior() {
    for (domain, paid, expected) in [
        (KnownHyperlaneDomain::Arbitrum, 1_000_000u64, 3_375_000u64),
        (KnownHyperlaneDomain::Ethereum, 1_000_000, 3_075_000),
        (KnownHyperlaneDomain::Arbitrum, 0, 3_000_000),
    ] {
        let (payload_db, tx_db, nonce_db) = tmp_dbs();
        let mut provider = MockEvmProvider::new();
        provider
            .expect_batch()
            .once()
            .returning(|_, _, _, _| Ok(empty_batch()));
        provider
            .expect_estimate_gas_limit()
            .times(4)
            .withf(|tx, _| tx.gas().is_none())
            .returning(|_, _| Ok(500_000.into()));
        provider
            .expect_estimate_batch()
            .times(2)
            .withf(move |_, precursors| {
                precursors
                    .iter()
                    .all(|(tx, _)| tx.gas() == Some(&EthersU256::from(paid.max(500_000))))
            })
            .returning(|_, _| Ok(3_000_000.into()));
        mock_get_block(&mut provider);
        let payloads = vec![
            paid_payload(paid, domain.into()).await,
            paid_payload(paid, domain.into()).await,
        ];
        for payload in &payloads {
            payload_db.store_payload_by_uuid(payload).await.unwrap();
        }
        let mut adapter = mock_ethereum_adapter(
            provider,
            payload_db,
            tx_db,
            nonce_db,
            H160::zero(),
            Duration::ZERO,
            Duration::ZERO,
        );
        adapter.domain = domain.into();
        let mut built = adapter.build_transactions(&payloads).await;
        assert_eq!(built.len(), 1);
        let mut tx = built[0].maybe_tx.take().unwrap();
        adapter.estimate_tx(&mut tx).await.unwrap();
        assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(expected)));
        tx.submission_attempts = 2;
        adapter.estimate_tx(&mut tx).await.unwrap();
        assert_eq!(tx.precursor().tx.gas(), Some(&EthersU256::from(expected)));
    }
}
