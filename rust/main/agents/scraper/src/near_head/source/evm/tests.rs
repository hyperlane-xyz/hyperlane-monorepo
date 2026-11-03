use super::*;
use ethers::{
    abi::{encode, Token},
    providers::Provider,
};

#[derive(Debug)]
struct ConcurrentCounts {
    inner: Provider<ethers::providers::MockProvider>,
    started: tokio::sync::Barrier,
    hash: EthersH256,
}

#[async_trait]
impl Middleware for ConcurrentCounts {
    type Error = ethers::providers::ProviderError;
    type Provider = ethers::providers::MockProvider;
    type Inner = Provider<Self::Provider>;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn call(
        &self,
        tx: &ethers::types::transaction::eip2718::TypedTransaction,
        block: Option<BlockId>,
    ) -> std::result::Result<ethers::types::Bytes, Self::Error> {
        assert_eq!(block, Some(BlockId::Hash(self.hash)));
        // Neither reply is available until both independent requests start.
        self.started.wait().await;
        let count: u32 = if tx.to() == Some(&H160::repeat_byte(1).into()) {
            9
        } else {
            7
        };
        Ok(encode(&[Token::Uint(count.into())]).into())
    }
}

#[tokio::test]
async fn sequence_count_requests_run_concurrently() -> Result<()> {
    let (inner, _) = Provider::mocked();
    let hash = EthersH256::repeat_byte(4);
    let source = EvmSource {
        provider: ConcurrentCounts {
            inner,
            started: tokio::sync::Barrier::new(2),
            hash,
        },
        contracts: EvmContracts {
            mailbox: H160::repeat_byte(1),
            hook: H160::repeat_byte(2),
            paymaster: H160::repeat_byte(3),
        },
        domain: 1,
    };
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), source.counts_at(hash)).await??,
        [9, 7]
    );
    Ok(())
}

#[tokio::test]
async fn sequence_counts_are_hash_pinned_and_reject_malformed_contract_replies() -> Result<()> {
    use ethers::types::Bytes;
    let (provider, rpc) = Provider::mocked();
    let source = EvmSource {
        provider,
        contracts: EvmContracts {
            mailbox: H160::repeat_byte(1),
            hook: H160::repeat_byte(2),
            paymaster: H160::repeat_byte(3),
        },
        domain: 1,
    };
    let hash = EthersH256::repeat_byte(4);
    let encoded = |value: u32| Bytes::from(encode(&[Token::Uint(value.into())]));
    rpc.push::<Bytes, _>(encoded(7))?;
    rpc.push::<Bytes, _>(encoded(9))?;
    assert_eq!(source.counts_at(hash).await?, [9, 7]);
    for (address, signature) in [
        (source.contracts.mailbox, "nonce()"),
        (source.contracts.hook, "count()"),
    ] {
        let call: ethers::types::transaction::eip2718::TypedTransaction = TransactionRequest::new()
            .to(address)
            .data(ethers::utils::id(signature)[..4].to_vec())
            .into();
        rpc.assert_request("eth_call", (call, BlockId::Hash(hash)))?;
    }
    // Empty results only mean zero before deployment, never for existing code.
    rpc.push::<Bytes, _>(Bytes::from(vec![1]))?;
    rpc.push::<Bytes, _>(Bytes::default())?;
    assert!(source.counts_at(hash).await.is_err());
    rpc.push::<Bytes, _>(encoded(0))?;
    rpc.push::<Bytes, _>(Bytes::default())?;
    rpc.push::<Bytes, _>(Bytes::default())?;
    assert_eq!(source.counts_at(hash).await?, [0, 0]);
    rpc.push::<Bytes, _>(Bytes::from(encode(&[Token::Uint(
        U256::from(u32::MAX) + 1,
    )])))?;
    assert!(source.counts_at(hash).await.is_err());
    Ok(())
}

/// RPCs such as ENI number logs within each transaction. Ordering by log index
/// alone would put nonce 1 (tx 1, log 0) before nonce 0 (tx 0, log 1).
#[tokio::test]
async fn dispatch_nonces_follow_chain_order_with_per_transaction_log_indexes() -> Result<()> {
    use hyperlane_core::Encode;

    let (provider, rpc) = Provider::mocked();
    let contracts = EvmContracts {
        mailbox: H160::repeat_byte(1),
        hook: H160::repeat_byte(2),
        paymaster: H160::repeat_byte(3),
    };
    let source = EvmSource {
        provider,
        contracts: contracts.clone(),
        domain: 1,
    };
    let sender = H160::repeat_byte(9);
    let dispatch = |nonce: u32, tx_index: u64, log_index: u64| {
        let message = HyperlaneMessage {
            version: 3,
            nonce,
            origin: 1,
            sender: EthersH256::from(sender).0.into(),
            destination: 2,
            recipient: hyperlane_core::H256::repeat_byte(2),
            body: vec![],
        };
        Log {
            address: contracts.mailbox,
            topics: vec![
                DispatchFilter::signature(),
                EthersH256::from(sender),
                EthersH256::from_low_u64_be(2),
                EthersH256::repeat_byte(2),
            ],
            data: encode(&[Token::Bytes(message.to_vec())]).into(),
            block_hash: Some(EthersH256::repeat_byte(4)),
            block_number: Some(10.into()),
            transaction_hash: Some(EthersH256::from_low_u64_be(100 + tx_index)),
            transaction_index: Some(tx_index.into()),
            log_index: Some(log_index.into()),
            removed: Some(false),
            ..Default::default()
        }
    };
    rpc.push::<Vec<Log>, _>(vec![dispatch(1, 1, 0), dispatch(0, 0, 1)])?;
    let events = source.events(10, 10).await?;
    let nonces = events
        .iter()
        .map(|event| match &event.data {
            EventData::Dispatch(message) => message.nonce,
            _ => unreachable!("only dispatches were returned"),
        })
        .collect::<Vec<_>>();
    assert_eq!(nonces, vec![0, 1]);
    crate::near_head::tests::validate_sequences(&events, [0, 0], [2, 0])?;
    Ok(())
}

#[tokio::test]
async fn gas_logs_require_the_requested_occurrence_and_unique_positions() -> Result<()> {
    let (provider, rpc) = Provider::mocked();
    let contracts = EvmContracts {
        mailbox: H160::repeat_byte(1),
        hook: H160::repeat_byte(2),
        paymaster: H160::repeat_byte(3),
    };
    let source = EvmSource {
        provider,
        contracts: contracts.clone(),
        domain: 1,
    };
    let header = Header {
        height: 10,
        timestamp: 1,
        hash: EthersH256::repeat_byte(4),
        parent: EthersH256::repeat_byte(5),
    };
    let log = Log {
        address: contracts.paymaster,
        topics: vec![
            GasPaymentFilter::signature(),
            EthersH256::repeat_byte(6),
            EthersH256::from_low_u64_be(42161),
        ],
        data: encode(&[Token::Uint(123.into()), Token::Uint(456.into())]).into(),
        block_hash: Some(header.hash),
        block_number: Some(header.height.into()),
        transaction_hash: Some(EthersH256::repeat_byte(7)),
        transaction_index: Some(0.into()),
        log_index: Some(1.into()),
        removed: Some(false),
        ..Default::default()
    };
    rpc.push::<Vec<Log>, _>(vec![log.clone()])?;
    let events = source.events(header.height, header.height + 100).await?;
    assert_eq!(events.len(), 1);
    assert!(
        matches!(&events[0].data, EventData::Gas { destination: 42161, gas, payment, .. } if gas == "123" && payment == "456")
    );
    rpc.assert_request("eth_getLogs", serde_json::json!([{
        "fromBlock": "0xa", "toBlock": "0x6e",
        "address": [contracts.mailbox, contracts.hook, contracts.paymaster],
        "topics": [[DispatchFilter::signature(), ProcessIdFilter::signature(), InsertedIntoTreeFilter::signature(), GasPaymentFilter::signature()]]
    }]))?;
    for invalid in [
        Log {
            block_number: Some(9.into()),
            ..log.clone()
        },
        Log {
            block_hash: None,
            ..log.clone()
        },
        Log {
            removed: Some(true),
            ..log.clone()
        },
        Log {
            transaction_index: None,
            ..log.clone()
        },
    ] {
        rpc.push::<Vec<Log>, _>(vec![invalid])?;
        assert!(source
            .events(header.height, header.height + 100)
            .await
            .is_err());
    }
    // Log indexes are unique within a block, not across the whole range.
    rpc.push::<Vec<Log>, _>(vec![
        log.clone(),
        Log {
            block_number: Some(11.into()),
            block_hash: Some(header.parent),
            ..log.clone()
        },
    ])?;
    assert_eq!(
        source
            .events(header.height, header.height + 100)
            .await?
            .len(),
        2
    );
    // Some RPCs number logs within each transaction rather than across the block.
    rpc.push::<Vec<Log>, _>(vec![
        Log {
            transaction_hash: Some(EthersH256::repeat_byte(8)),
            transaction_index: Some(1.into()),
            ..log.clone()
        },
        log.clone(),
    ])?;
    let events = source.events(header.height, header.height + 100).await?;
    assert_eq!(
        events
            .iter()
            .map(|event| (event.tx_index, event.log_index))
            .collect::<Vec<_>>(),
        vec![(0, 1), (1, 1)]
    );
    rpc.push::<Vec<Log>, _>(vec![log.clone(), log.clone()])?;
    assert!(source
        .events(header.height, header.height + 100)
        .await
        .is_err());
    // The same transaction must not appear at two indexes, which would store
    // one log twice under different positions.
    rpc.push::<Vec<Log>, _>(vec![
        log.clone(),
        Log {
            transaction_index: Some(1.into()),
            ..log
        },
    ])?;
    assert!(source
        .events(header.height, header.height + 100)
        .await
        .unwrap_err()
        .to_string()
        .contains("one transaction at two indexes"));
    Ok(())
}
