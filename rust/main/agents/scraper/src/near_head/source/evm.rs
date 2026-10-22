//! EVM logs and sequence counts pinned to a block hash.
use super::{BlockSelector, Event, EventData, Header, Source};
use async_trait::async_trait;
use ethers::{
    abi::RawLog,
    contract::EthEvent,
    providers::Middleware,
    types::{
        BlockId, BlockNumber, Filter, Log, TransactionRequest, H160, H256 as EthersH256, U256,
    },
};
use eyre::{ensure, eyre, Result};
use hyperlane_core::{ContractLocator, Decode, HyperlaneMessage, H256};
use hyperlane_ethereum::{
    event_filters::{DispatchFilter, GasPaymentFilter, InsertedIntoTreeFilter, ProcessIdFilter},
    BuildableWithProvider, ConnectionConf,
};
use std::collections::HashMap;

pub(in crate::near_head) struct SourceBuilder {
    pub contracts: EvmContracts,
    pub domain: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::near_head) struct EvmContracts {
    pub mailbox: H160,
    pub hook: H160,
    pub paymaster: H160,
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
    contracts: EvmContracts,
    domain: u32,
}

impl<M: Middleware + 'static> EvmSource<M> {
    async fn count(&self, address: H160, signature: &str, hash: EthersH256) -> Result<u32> {
        let call = TransactionRequest::new()
            .to(address)
            .data(ethers::utils::id(signature)[..4].to_vec())
            .into();
        let result = self.provider.call(&call, Some(BlockId::Hash(hash))).await?;
        if result.is_empty()
            && self
                .provider
                .get_code(address, Some(BlockId::Hash(hash)))
                .await?
                .is_empty()
        {
            return Ok(0); // The range may start before the contract was deployed.
        }
        ensure!(result.len() == 32, "Invalid contract sequence count");
        let value = U256::from_big_endian(&result);
        ensure!(
            value <= U256::from(u32::MAX),
            "Contract sequence count overflow"
        );
        Ok(value.as_u32())
    }

    async fn counts_at(&self, hash: EthersH256) -> Result<[u32; 2]> {
        let (dispatches, insertions) = tokio::try_join!(
            self.count(self.contracts.mailbox, "nonce()", hash),
            self.count(self.contracts.hook, "count()", hash),
        )?;
        Ok([dispatches, insertions])
    }
}

#[async_trait]
impl<M: Middleware + 'static> Source for EvmSource<M> {
    async fn header(&self, selector: BlockSelector) -> Result<Header> {
        let number = match selector {
            BlockSelector::Height(height) => BlockNumber::Number(height.into()),
            BlockSelector::Latest => BlockNumber::Latest,
            BlockSelector::Safe => BlockNumber::Safe,
            BlockSelector::Finalized => BlockNumber::Finalized,
        };
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

    async fn counts(&self, hash: EthersH256) -> Result<Option<[u32; 2]>> {
        Ok(Some(self.counts_at(hash).await?))
    }

    fn has_historical_counts(&self) -> bool {
        true
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
        events.sort_by_key(|event| (event.block_number, event.tx_index, event.log_index));
        ensure!(
            events.windows(2).all(|pair| {
                (pair[0].block_number, pair[0].tx_index, pair[0].log_index)
                    != (pair[1].block_number, pair[1].tx_index, pair[1].log_index)
            }),
            "Duplicate event position"
        );
        // Positions include the transaction index, so one transaction reported at
        // two indexes would otherwise store the same log twice.
        let mut tx_positions = HashMap::new();
        for event in &events {
            let previous = tx_positions.insert((event.block_hash, event.tx_hash), event.tx_index);
            ensure!(
                previous.is_none_or(|index| index == event.tx_index),
                "RPC reported one transaction at two indexes"
            );
        }
        Ok(events)
    }
}

fn decode(contracts: &EvmContracts, domain: u32, log: Log) -> Result<Option<Event>> {
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
                && message.sender.as_bytes() == EthersH256::from(event.sender).as_bytes(),
            "Dispatch fields disagree with message"
        );
        EventData::Dispatch(message)
    } else if log.address == contracts.mailbox && topic == ProcessIdFilter::signature() {
        EventData::Delivery(H256::from_slice(
            &ProcessIdFilter::decode_log(&raw)?.message_id,
        ))
    } else if log.address == contracts.hook && topic == InsertedIntoTreeFilter::signature() {
        let event = InsertedIntoTreeFilter::decode_log(&raw)?;
        EventData::Insertion {
            index: event.index,
            message_id: H256::from_slice(&event.message_id),
        }
    } else if log.address == contracts.paymaster && topic == GasPaymentFilter::signature() {
        let event = GasPaymentFilter::decode_log(&raw)?;
        EventData::Gas {
            message_id: H256::from_slice(&event.message_id),
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
        address: log.address.into(),
        tx_hash: Some(
            log.transaction_hash
                .ok_or_else(|| eyre!("Missing transaction hash"))?
                .into(),
        ),
        tx_index: log
            .transaction_index
            .ok_or_else(|| eyre!("Missing transaction index"))?
            .as_u64(),
        log_index: log_index.as_u64(),
        sequence: None,
    }))
}

#[cfg(test)]
mod tests;
