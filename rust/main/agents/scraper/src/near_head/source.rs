use async_trait::async_trait;
use ethers::{
    abi::RawLog,
    contract::EthEvent,
    providers::Middleware,
    types::{BlockId, BlockNumber, Filter, Log, H160, H256},
};
use eyre::{ensure, eyre, Result};
use hyperlane_core::{ContractLocator, Decode, HyperlaneMessage};
use hyperlane_ethereum::{
    event_filters::{DispatchFilter, GasPaymentFilter, InsertedIntoTreeFilter, ProcessIdFilter},
    BuildableWithProvider, ConnectionConf,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Header {
    pub height: u64,
    pub timestamp: u64,
    pub hash: H256,
    pub parent: H256,
}

#[derive(Clone, Debug)]
pub(super) struct Event {
    pub block_number: u64,
    pub block_hash: H256,
    pub address: H160,
    pub tx_hash: H256,
    pub tx_index: u64,
    pub log_index: u64,
    pub data: EventData,
}

#[derive(Clone, Debug)]
pub(super) enum EventData {
    Dispatch(HyperlaneMessage),
    Delivery(H256),
    Insertion {
        message_id: H256,
        index: u32,
    },
    Gas {
        message_id: H256,
        destination: u32,
        gas: String,
        payment: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Contracts {
    pub mailbox: H160,
    pub hook: H160,
    pub paymaster: H160,
}

#[async_trait]
pub(super) trait Source: Send + Sync {
    async fn header(&self, block: BlockNumber) -> Result<Header>;
    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>>;
}

pub(super) struct SourceBuilder {
    pub contracts: Contracts,
    pub domain: u32,
}

#[async_trait]
impl BuildableWithProvider for SourceBuilder {
    type Output = Box<dyn Source>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        _locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EvmSource {
            provider,
            contracts: self.contracts.clone(),
            domain: self.domain,
        })
    }
}

struct EvmSource<M> {
    provider: M,
    contracts: Contracts,
    domain: u32,
}

#[async_trait]
impl<M: Middleware + 'static> Source for EvmSource<M> {
    async fn header(&self, number: BlockNumber) -> Result<Header> {
        let block = self
            .provider
            .get_block(BlockId::Number(number))
            .await?
            .ok_or_else(|| eyre!("Missing stream block {number:?}"))?;
        let height = block
            .number
            .ok_or_else(|| eyre!("Missing block number"))?
            .as_u64();
        if let BlockNumber::Number(expected) = number {
            ensure!(
                height == expected.as_u64(),
                "RPC returned incorrect block height"
            );
        }
        Ok(Header {
            height,
            timestamp: block.timestamp.as_u64(),
            hash: block.hash.ok_or_else(|| eyre!("Missing block hash"))?,
            parent: block.parent_hash,
        })
    }

    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        ensure!(from <= through, "Invalid event range");
        let filter = Filter::new()
            .from_block(from)
            .to_block(through)
            .address(vec![
                self.contracts.mailbox,
                self.contracts.hook,
                self.contracts.paymaster,
            ])
            .topic0(vec![
                DispatchFilter::signature(),
                ProcessIdFilter::signature(),
                InsertedIntoTreeFilter::signature(),
                GasPaymentFilter::signature(),
            ]);
        let logs = self.provider.get_logs(&filter).await?;
        let mut events = Vec::new();
        for log in logs {
            ensure!(
                log.block_hash.is_some()
                    && log
                        .block_number
                        .is_some_and(|height| (from..=through).contains(&height.as_u64()))
                    && !log.removed.unwrap_or(false),
                "RPC returned an event from a different block"
            );
            if let Some(event) = decode(&self.contracts, self.domain, log)? {
                events.push(event);
            }
        }
        events.sort_by_key(|event| (event.block_number, event.log_index));
        ensure!(
            events
                .windows(2)
                .all(|pair| (pair[0].block_number, pair[0].log_index)
                    != (pair[1].block_number, pair[1].log_index)),
            "Duplicate event position"
        );
        Ok(events)
    }
}

fn decode(contracts: &Contracts, domain: u32, log: Log) -> Result<Option<Event>> {
    let topic = log
        .topics
        .first()
        .copied()
        .ok_or_else(|| eyre!("Missing event signature"))?;
    let raw = RawLog {
        topics: log.topics.clone(),
        data: log.data.to_vec(),
    };
    let data = if log.address == contracts.mailbox && topic == DispatchFilter::signature() {
        let event = DispatchFilter::decode_log(&raw)?;
        let message = HyperlaneMessage::read_from(&mut event.message.as_ref())?;
        ensure!(
            message.origin == domain
                && message.destination == event.destination
                && message.recipient.as_bytes() == event.recipient
                && message.sender.as_bytes() == H256::from(event.sender).as_bytes(),
            "Dispatch fields disagree with message"
        );
        EventData::Dispatch(message)
    } else if log.address == contracts.mailbox && topic == ProcessIdFilter::signature() {
        EventData::Delivery(H256::from(ProcessIdFilter::decode_log(&raw)?.message_id))
    } else if log.address == contracts.hook && topic == InsertedIntoTreeFilter::signature() {
        let event = InsertedIntoTreeFilter::decode_log(&raw)?;
        EventData::Insertion {
            index: event.index,
            message_id: H256::from(event.message_id),
        }
    } else if log.address == contracts.paymaster && topic == GasPaymentFilter::signature() {
        let event = GasPaymentFilter::decode_log(&raw)?;
        EventData::Gas {
            message_id: H256::from(event.message_id),
            destination: event.destination_domain,
            gas: event.gas_amount.to_string(),
            payment: event.payment.to_string(),
        }
    } else {
        return Ok(None);
    };
    let log_index = log.log_index.ok_or_else(|| eyre!("Missing log index"))?;
    ensure!(log_index <= i64::MAX.into(), "Log index too large");
    Ok(Some(Event {
        block_number: log
            .block_number
            .ok_or_else(|| eyre!("Missing block number"))?
            .as_u64(),
        block_hash: log.block_hash.ok_or_else(|| eyre!("Missing block hash"))?,
        data,
        address: log.address,
        tx_hash: log
            .transaction_hash
            .ok_or_else(|| eyre!("Missing transaction hash"))?,
        tx_index: log
            .transaction_index
            .ok_or_else(|| eyre!("Missing transaction index"))?
            .as_u64(),
        log_index: log_index.as_u64(),
    }))
}

#[cfg(test)]
mod tests {
    use ethers::{
        abi::{encode, Token},
        providers::Provider,
    };

    use super::*;

    #[tokio::test]
    async fn gas_logs_require_the_requested_occurrence_and_unique_positions() -> Result<()> {
        let (provider, rpc) = Provider::mocked();
        let contracts = Contracts {
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
            hash: H256::repeat_byte(4),
            parent: H256::repeat_byte(5),
        };
        let log = Log {
            address: contracts.paymaster,
            topics: vec![
                GasPaymentFilter::signature(),
                H256::repeat_byte(6),
                H256::from_low_u64_be(42161),
            ],
            data: encode(&[Token::Uint(123.into()), Token::Uint(456.into())]).into(),
            block_hash: Some(header.hash),
            block_number: Some(header.height.into()),
            transaction_hash: Some(H256::repeat_byte(7)),
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
        rpc.push::<Vec<Log>, _>(vec![log.clone(), log])?;
        assert!(source
            .events(header.height, header.height + 100)
            .await
            .is_err());
        Ok(())
    }
}
