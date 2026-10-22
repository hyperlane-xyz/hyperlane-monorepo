use super::*;
use hyperlane_core::H512;
use std::{
    marker::PhantomData,
    ops::RangeInclusive,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug)]
struct EmptyIndexer<T>(PhantomData<T>);

#[async_trait]
impl<T: Send + Sync + std::fmt::Debug> hyperlane_core::Indexer<T> for EmptyIndexer<T> {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> hyperlane_core::ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(Vec::new())
    }

    async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
        Ok(7)
    }
}

#[async_trait]
impl<T: Send + Sync + std::fmt::Debug> SequenceAwareIndexer<T> for EmptyIndexer<T> {
    async fn latest_sequence_count_and_tip(
        &self,
    ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
        Ok((Some(0), 7))
    }
}

#[derive(Debug)]
struct CountingEmptyIndexer<T> {
    calls: Arc<AtomicUsize>,
    marker: PhantomData<T>,
}

#[async_trait]
impl<T: Send + Sync + std::fmt::Debug> hyperlane_core::Indexer<T> for CountingEmptyIndexer<T> {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> hyperlane_core::ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(Vec::new())
    }

    async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
        Ok(7)
    }
}

#[async_trait]
impl<T: Send + Sync + std::fmt::Debug> SequenceAwareIndexer<T> for CountingEmptyIndexer<T> {
    async fn latest_sequence_count_and_tip(
        &self,
    ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok((Some(0), 7))
    }
}

#[derive(Clone, Debug)]
struct CountingProvider {
    domain: hyperlane_core::HyperlaneDomain,
    calls: Arc<AtomicUsize>,
}

impl hyperlane_core::HyperlaneChain for CountingProvider {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for CountingProvider {
    async fn get_block_by_height(
        &self,
        height: u64,
    ) -> hyperlane_core::ChainResult<hyperlane_core::BlockInfo> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(hyperlane_core::BlockInfo {
            hash: H256::from_low_u64_be(height),
            timestamp: height,
            number: height,
        })
    }

    async fn get_txn_by_hash(
        &self,
        _hash: &H512,
    ) -> hyperlane_core::ChainResult<hyperlane_core::TxnInfo> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }

    async fn is_contract(&self, _address: &H256) -> hyperlane_core::ChainResult<bool> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }

    async fn get_balance(
        &self,
        _address: String,
    ) -> hyperlane_core::ChainResult<hyperlane_core::U256> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }

    async fn get_chain_metrics(
        &self,
    ) -> hyperlane_core::ChainResult<Option<hyperlane_core::ChainInfo>> {
        Ok(Some(hyperlane_core::ChainInfo::new(7, None)))
    }
}

#[tokio::test]
async fn generic_headers_are_cached_per_cycle_with_explicit_fresh_reads() -> Result<()> {
    let calls = Arc::new(AtomicUsize::new(0));
    let source = GenericSource {
        provider: Box::new(CountingProvider {
            domain: hyperlane_core::HyperlaneDomain::new_test_domain("header-cache"),
            calls: calls.clone(),
        }),
        messages: Box::new(EmptyIndexer::<HyperlaneMessage>(PhantomData)),
        deliveries: Box::new(EmptyIndexer::<H256>(PhantomData)),
        payments: Box::new(EmptyIndexer::<InterchainGasPayment>(PhantomData)),
        insertions: Box::new(EmptyIndexer::<MerkleTreeInsertion>(PhantomData)),
        contracts: Contracts {
            mailbox: H256::zero(),
            hook: H256::zero(),
            paymaster: H256::zero(),
        },
        sequence_mode: false,
        derive_insertions_from_messages: false,
        chunk_size: 1,
        headers: RwLock::new(HashMap::new()),
        streams: RwLock::new(None),
    };

    source.begin_cycle().await;
    source.header(BlockSelector::Height(7)).await?;
    source.header(BlockSelector::Height(7)).await?;
    assert_eq!(calls.load(Ordering::Relaxed), 1);

    source.fresh_header(BlockSelector::Height(7)).await?;
    source.header(BlockSelector::Height(7)).await?;
    assert_eq!(calls.load(Ordering::Relaxed), 2);

    source.begin_cycle().await;
    source.header(BlockSelector::Height(7)).await?;
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    Ok(())
}

#[tokio::test]
async fn empty_anchor_uses_the_zero_count_common_tip() -> Result<()> {
    let calls = Arc::new(AtomicUsize::new(0));
    let source = GenericSource {
        provider: Box::new(CountingProvider {
            domain: hyperlane_core::HyperlaneDomain::new_test_domain("empty-anchor"),
            calls,
        }),
        messages: Box::new(EmptyIndexer::<HyperlaneMessage>(PhantomData)),
        deliveries: Box::new(EmptyIndexer::<H256>(PhantomData)),
        payments: Box::new(EmptyIndexer::<InterchainGasPayment>(PhantomData)),
        insertions: Box::new(EmptyIndexer::<MerkleTreeInsertion>(PhantomData)),
        contracts: Contracts {
            mailbox: H256::zero(),
            hook: H256::zero(),
            paymaster: H256::zero(),
        },
        sequence_mode: true,
        derive_insertions_from_messages: false,
        chunk_size: 1,
        headers: RwLock::new(HashMap::new()),
        streams: RwLock::new(None),
    };

    assert_eq!(
        source.empty_anchor().await?,
        Some(Header {
            height: 7,
            timestamp: 7,
            hash: EthersH256::from_low_u64_be(7),
            parent: EthersH256::zero(),
        })
    );
    Ok(())
}

#[tokio::test]
async fn generic_stream_tips_are_cached_per_cycle_and_derive_insertions() -> Result<()> {
    let messages = Arc::new(AtomicUsize::new(0));
    let deliveries = Arc::new(AtomicUsize::new(0));
    let payments = Arc::new(AtomicUsize::new(0));
    let insertions = Arc::new(AtomicUsize::new(0));
    let source = GenericSource {
        provider: Box::new(CountingProvider {
            domain: hyperlane_core::HyperlaneDomain::new_test_domain("stream-cache"),
            calls: Arc::new(AtomicUsize::new(0)),
        }),
        messages: Box::new(CountingEmptyIndexer::<HyperlaneMessage> {
            calls: messages.clone(),
            marker: PhantomData,
        }),
        deliveries: Box::new(CountingEmptyIndexer::<H256> {
            calls: deliveries.clone(),
            marker: PhantomData,
        }),
        payments: Box::new(CountingEmptyIndexer::<InterchainGasPayment> {
            calls: payments.clone(),
            marker: PhantomData,
        }),
        insertions: Box::new(CountingEmptyIndexer::<MerkleTreeInsertion> {
            calls: insertions.clone(),
            marker: PhantomData,
        }),
        contracts: Contracts {
            mailbox: H256::zero(),
            hook: H256::zero(),
            paymaster: H256::zero(),
        },
        sequence_mode: true,
        derive_insertions_from_messages: true,
        chunk_size: 1,
        headers: RwLock::new(HashMap::new()),
        streams: RwLock::new(None),
    };

    assert_eq!(source.indexing_tip().await?, Some(7));
    assert_eq!(source.has_events_after([0; 4]).await?, Some(false));
    assert_eq!(source.events_after(0, 7, [0; 4]).await?.through, 7);
    assert_eq!(messages.load(Ordering::Relaxed), 1);
    assert_eq!(deliveries.load(Ordering::Relaxed), 1);
    assert_eq!(payments.load(Ordering::Relaxed), 1);
    assert_eq!(insertions.load(Ordering::Relaxed), 0);

    source.begin_cycle().await;
    assert_eq!(source.indexing_tip().await?, Some(7));
    assert_eq!(messages.load(Ordering::Relaxed), 2);
    assert_eq!(deliveries.load(Ordering::Relaxed), 2);
    assert_eq!(payments.load(Ordering::Relaxed), 2);
    assert_eq!(insertions.load(Ordering::Relaxed), 0);
    Ok(())
}

#[derive(Debug)]
struct SequenceIndexer {
    count: u32,
    tip: u32,
    truncate_last: bool,
    requests: Mutex<Vec<RangeInclusive<u32>>>,
}

#[async_trait]
impl hyperlane_core::Indexer<HyperlaneMessage> for SequenceIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> hyperlane_core::ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        self.requests
            .lock()
            .expect("request mutex poisoned")
            .push(range.clone());
        let mut logs: Vec<_> = range
            .map(|sequence| {
                (
                    Indexed::new(HyperlaneMessage::default()).with_sequence(sequence),
                    LogMeta {
                        block_number: u64::from(sequence),
                        ..LogMeta::default()
                    },
                )
            })
            .collect();
        if self.truncate_last {
            logs.pop();
        }
        Ok(logs)
    }

    async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
        Ok(200)
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for SequenceIndexer {
    async fn latest_sequence_count_and_tip(
        &self,
    ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
        Ok((Some(self.count), self.tip))
    }
}

#[tokio::test]
async fn sequence_mode_translates_durable_count_to_sequence_range() -> Result<()> {
    let indexer = SequenceIndexer {
        count: 10,
        tip: 200,
        truncate_last: false,
        requests: Mutex::new(Vec::new()),
    };
    GenericSource::logs(&indexer, (Some(10), 200), 100..=200, 7, true, 2).await?;
    assert_eq!(
        *indexer.requests.lock().expect("request mutex poisoned"),
        vec![7..=8]
    );
    assert!(
        GenericSource::logs(&indexer, (Some(10), 200), 100..=200, 11, true, 2)
            .await
            .is_err()
    );

    let partial = SequenceIndexer {
        count: 10,
        tip: 200,
        truncate_last: true,
        requests: Mutex::new(Vec::new()),
    };
    assert!(
        GenericSource::logs(&partial, (Some(10), 200), 100..=200, 7, true, 10)
            .await
            .is_err()
    );

    let bounded = SequenceIndexer {
        count: 100,
        tip: 200,
        truncate_last: false,
        requests: Mutex::new(Vec::new()),
    };
    let bounded_result = GenericSource::logs(&bounded, (Some(100), 200), 0..=3, 0, true, 2).await?;
    assert_eq!(bounded_result.1, 0);
    assert_eq!(
        *bounded.requests.lock().expect("request mutex poisoned"),
        vec![0..=1]
    );
    let lagging = SequenceIndexer {
        count: 10,
        tip: 199,
        truncate_last: false,
        requests: Mutex::new(Vec::new()),
    };
    assert!(
        GenericSource::logs(&lagging, (Some(10), 199), 100..=200, 7, true, 2)
            .await
            .is_err()
    );
    assert!(lagging
        .requests
        .lock()
        .expect("request mutex poisoned")
        .is_empty());
    Ok(())
}

#[test]
fn generic_events_are_deduplicated_without_rewriting_log_positions() -> Result<()> {
    let event = |block_number, log_index| Event {
        block_number,
        block_hash: EthersH256::zero(),
        address: H256::zero(),
        tx_hash: None,
        tx_index: 0,
        log_index,
        sequence: None,
        data: EventData::Gas {
            message_id: H256::zero(),
            destination: 0,
            gas: "0".into(),
            payment: "0".into(),
        },
    };
    let repeated = event(7, 0);
    let mut distinct = event(7, 0);
    distinct.data = EventData::Gas {
        message_id: H256::repeat_byte(1),
        destination: 0,
        gas: "0".into(),
        payment: "0".into(),
    };
    let mut events = vec![repeated.clone(), distinct, repeated, event(8, 0)];
    GenericSource::normalize_events(&mut events);
    assert_eq!(
        events
            .into_iter()
            .map(|event| event.log_index)
            .collect::<Vec<_>>(),
        vec![0, 0, 0]
    );

    let delivery = |sequence, tx_index| Event {
        block_number: 9,
        block_hash: EthersH256::zero(),
        address: H256::zero(),
        tx_hash: None,
        tx_index,
        log_index: 0,
        sequence: Some(sequence),
        data: EventData::Delivery(H256::from_low_u64_be(u64::from(sequence))),
    };
    let mut mixed_metadata = vec![delivery(7, 2), delivery(8, 0)];
    GenericSource::normalize_events(&mut mixed_metadata);
    assert_eq!(
        mixed_metadata
            .into_iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![Some(7), Some(8)]
    );
    Ok(())
}
