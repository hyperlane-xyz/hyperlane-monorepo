//! Reproduces the mainnet stall where #9683's full-history loader recovered ancient
//! PendingInclusion transactions whose payloads were already delivered. They were re-nonced
//! above the finalized nonce but never broadcast, parking a live transaction behind them.
//!
//! Recovery drops the stale txs so their nonces are freed. New txs refill the freed nonces
//! first, so the parked tx is mined in order at its original nonce without a second broadcast.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ethers::abi::{Function, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip2930::AccessList;
use ethers::types::{Address, Eip1559TransactionRequest, NameOrAddress, U256 as EthersU256, U64};
use hyperlane_core::{H256, U256};
use tokio::sync::mpsc;

use crate::adapter::chains::ethereum::tests::MockEvmProvider;
use crate::adapter::chains::ethereum::transaction::Precursor;
use crate::adapter::chains::ethereum::{EthereumAdapter, NonceManagerState};
use crate::adapter::AdaptsChain;
use crate::dispatcher::{DispatcherState, TransactionDbLoader};
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, Transaction};
use crate::{DispatcherMetrics, FullPayload, LanderError, TransactionStatus};

const FINALIZED: u64 = 1000;

fn typed_tx_and_function() -> Vec<u8> {
    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(EthersU256::from(21000)),
        value: None,
        data: None,
        nonce: None,
        access_list: AccessList::default(),
        max_fee_per_gas: None,
        max_priority_fee_per_gas: None,
        chain_id: Some(U64::from(1)),
    });
    #[allow(deprecated)]
    let function = Function {
        name: "delivered".into(),
        inputs: Vec::new(),
        outputs: Vec::new(),
        constant: None,
        state_mutability: StateMutability::View,
    };
    serde_json::to_vec(&(typed_tx, function)).unwrap()
}

fn provider(sent_nonces: Arc<Mutex<Vec<u64>>>) -> MockEvmProvider {
    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(FINALIZED + 1)));
    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });
    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });
    // None of the stale hashes landed on chain.
    provider
        .expect_get_transaction_receipt()
        .returning(|_| Ok(None));
    // Every payload's success criteria (mailbox.delivered) is satisfied.
    provider.expect_check().returning(|_, _| Ok(true));
    provider.expect_send().returning(move |tx, _| {
        sent_nonces
            .lock()
            .unwrap()
            .push(tx.nonce().expect("sent tx has a nonce").as_u64());
        Ok(H256::random())
    });
    provider
}

async fn build_tx(adapter: &EthereumAdapter, state: &DispatcherState) -> Transaction {
    let mut payload = FullPayload::random();
    payload.data = typed_tx_and_function();
    payload.details.success_criteria = Some(typed_tx_and_function());
    state
        .payload_db
        .store_payload_by_uuid(&payload)
        .await
        .unwrap();
    adapter.build_transactions(&[payload]).await[0]
        .maybe_tx
        .clone()
        .unwrap()
}

/// Persist an ancient PendingInclusion transaction that was re-nonced to `nonce` but never
/// broadcast, as the incident left it.
async fn store_stale_tx(
    adapter: &EthereumAdapter,
    state: &DispatcherState,
    nonce_state: &NonceManagerState,
    nonce: u64,
) -> Transaction {
    let mut tx = build_tx(adapter, state).await;
    tx.tx_hashes = vec![H256::random().into()];
    tx.submission_attempts = 2384;
    tx.creation_timestamp = chrono::Utc::now() - chrono::Duration::days(300);
    tx.precursor_mut().tx.set_nonce(U256::from(nonce));
    nonce_state
        .set_tracked_tx_uuid_test(&U256::from(nonce), &tx.uuid)
        .await
        .unwrap();
    state.store_tx(&tx).await;
    tx
}

fn nonce_of(tx: &Transaction) -> u64 {
    tx.precursor().tx.nonce().unwrap().as_u64()
}

#[tokio::test]
async fn restart_drops_stale_recovered_txs_and_refills_freed_nonces() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let sent_nonces = Arc::new(Mutex::new(Vec::new()));
    let signer = Address::random();
    let mut adapter = mock_ethereum_adapter(
        provider(sent_nonces.clone()),
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        Duration::from_millis(100),
        Duration::from_millis(0),
    );
    // Cap escalation at the estimate so a resubmission sees the same gas price.
    adapter.transaction_overrides.gas_price_cap_multiplier = Some(U256::one());
    let adapter = Arc::new(adapter);
    let nonce_state = adapter.nonce_manager.state.clone();
    let state = DispatcherState::new(
        payload_db,
        tx_db.clone(),
        adapter.clone(),
        DispatcherMetrics::dummy_instance(),
        "arbitrum".to_owned(),
    );

    nonce_state
        .set_finalized_nonce_test(&U256::from(FINALIZED))
        .await
        .unwrap();

    // Oldest history: stale txs re-nonced just above finalized, and one above where the
    // live tx will be parked.
    let mut stale = Vec::new();
    for nonce in [FINALIZED + 1, FINALIZED + 2, FINALIZED + 3, FINALIZED + 5] {
        stale.push(store_stale_tx(&adapter, &state, &nonce_state, nonce).await);
    }
    nonce_state
        .set_upper_nonce_test(&U256::from(FINALIZED + 4))
        .await
        .unwrap();

    // The old loader stopped at the first terminal entry.
    let mut boundary = build_tx(&adapter, &state).await;
    boundary.status = TransactionStatus::Finalized;
    state.store_tx(&boundary).await;

    // A live tx submitted after the stale ones got parked above them.
    let mut parked = build_tx(&adapter, &state).await;
    adapter.submit(&mut parked).await.unwrap();
    assert_eq!(nonce_of(&parked), FINALIZED + 4);
    parked.status = TransactionStatus::Mempool;
    state.store_tx(&parked).await;

    nonce_state
        .set_upper_nonce_test(&U256::from(FINALIZED + 6))
        .await
        .unwrap();
    assert_eq!(*sent_nonces.lock().unwrap(), vec![FINALIZED + 4]);

    // Restart with the full-history loader.
    let (inclusion_tx, mut inclusion_rx) = mpsc::channel(16);
    let (finality_tx, mut finality_rx) = mpsc::channel(16);
    TransactionDbLoader::new(
        state.clone(),
        inclusion_tx,
        finality_tx,
        "arbitrum".to_owned(),
    )
    .into_iterator()
    .await
    .load_from_db(DispatcherMetrics::dummy_instance())
    .await
    .unwrap();

    // Only the live tx is enqueued; stale ones are dropped, never re-nonced or resubmitted.
    let recovered = inclusion_rx.try_recv().unwrap();
    assert_eq!(recovered.uuid, parked.uuid);
    assert!(inclusion_rx.try_recv().is_err());
    assert!(finality_rx.try_recv().is_err());
    for tx in &stale {
        let stored = tx_db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                stored.status,
                TransactionStatus::Dropped(DropReason::Other(_))
            ),
            "stale tx should be dropped: {:?}",
            stored.status
        );
    }
    assert_eq!(*sent_nonces.lock().unwrap(), vec![FINALIZED + 4]);

    // Boundary update lowers upper past the freed trailing nonce to the parked tx.
    nonce_state
        .update_boundary_nonces(&U256::from(FINALIZED))
        .await
        .unwrap();
    assert_eq!(
        nonce_state.get_upper_nonce_test().await.unwrap(),
        U256::from(FINALIZED + 5)
    );

    // A possibly broadcast tx is never moved to another nonce, even with lower nonces freed:
    // its copy at the old nonce could still be mined.
    let mut parked = recovered;
    let hashes_before = parked.tx_hashes.len();
    for status in [
        TransactionStatus::Mempool,
        TransactionStatus::PendingInclusion,
    ] {
        let mut probe = parked.clone();
        probe.status = status;
        let nonce = adapter.calculate_nonce(&probe).await.unwrap();
        assert_eq!(nonce, U256::from(FINALIZED + 4));
    }
    // Resubmitting it at an unchanged nonce and gas price is suppressed.
    let err = adapter.submit(&mut parked).await.unwrap_err();
    assert!(matches!(err, LanderError::TxAlreadyExists), "{err:?}");
    assert_eq!(nonce_of(&parked), FINALIZED + 4);
    assert_eq!(parked.tx_hashes.len(), hashes_before);

    // New txs reuse the freed nonces below the parked tx, in order.
    for expected in [FINALIZED + 1, FINALIZED + 2, FINALIZED + 3] {
        let mut fresh = build_tx(&adapter, &state).await;
        adapter.submit(&mut fresh).await.unwrap();
        assert_eq!(nonce_of(&fresh), expected);
        state.store_tx(&fresh).await;
    }

    // With the gap filled, the next new tx goes above the parked tx, reusing the trimmed nonce.
    let mut next = build_tx(&adapter, &state).await;
    adapter.submit(&mut next).await.unwrap();
    assert_eq!(nonce_of(&next), FINALIZED + 5);
    state.store_tx(&next).await;

    // The parked tx still holds its original nonce and was broadcast exactly once.
    let err = adapter.submit(&mut parked).await.unwrap_err();
    assert!(matches!(err, LanderError::TxAlreadyExists), "{err:?}");
    assert_eq!(nonce_of(&parked), FINALIZED + 4);
    let sent = sent_nonces.lock().unwrap().clone();
    assert_eq!(
        sent,
        vec![
            FINALIZED + 4,
            FINALIZED + 1,
            FINALIZED + 2,
            FINALIZED + 3,
            FINALIZED + 5
        ]
    );
    assert_eq!(sent.iter().filter(|n| **n == FINALIZED + 4).count(), 1);

    // Upper sits just above the highest nonce held by a live tx.
    nonce_state
        .update_boundary_nonces(&U256::from(FINALIZED))
        .await
        .unwrap();
    assert_eq!(
        nonce_state.get_upper_nonce_test().await.unwrap(),
        U256::from(FINALIZED + 6)
    );
}
