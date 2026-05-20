#![allow(missing_docs)]

use std::collections::HashMap;
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use ethers::types::{Filter, Log, H160 as EthersH160, H256 as EthersH256};
use ethers_contract::LogMeta as EthersLogMeta;
use ethers_core::utils::keccak256;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    SameChainCcrSwap, SequenceAwareIndexer, H160, H256, U256,
};

use super::utils::get_finalized_block_number;
use crate::{BuildableWithProvider, ConnectionConf, EthereumReorgPeriod};

/// topic0 for `ReceivedTransferRemote(uint32,bytes32,uint256)`
fn received_transfer_remote_topic() -> EthersH256 {
    EthersH256::from(keccak256(b"ReceivedTransferRemote(uint32,bytes32,uint256)"))
}

/// topic0 for ERC20 `Transfer(address,address,uint256)`
fn erc20_transfer_topic() -> EthersH256 {
    EthersH256::from(keccak256(b"Transfer(address,address,uint256)"))
}

/// Decode a `ReceivedTransferRemote` log. Returns `None` if the log doesn't match.
fn decode_received_transfer_remote(log: &Log) -> Option<(u32, H256, U256)> {
    if log.topics.first() != Some(&received_transfer_remote_topic()) {
        return None;
    }
    let origin = u32::from_be_bytes(log.topics.get(1)?[28..32].try_into().ok()?);
    let recipient = H256::from(log.topics.get(2)?.0);
    let amount = U256::from_big_endian(&log.data[..32]);
    Some((origin, recipient, amount))
}

/// Decode an ERC20 `Transfer` log. Returns `(from, to, value)` or `None`.
fn decode_erc20_transfer(log: &Log) -> Option<(EthersH160, EthersH160, U256)> {
    if log.topics.first() != Some(&erc20_transfer_topic()) {
        return None;
    }
    // address is stored right-aligned in the 32-byte topic
    let from = EthersH160::from_slice(&log.topics.get(1)?[12..32]);
    let to = EthersH160::from_slice(&log.topics.get(2)?[12..32]);
    let value = U256::from_big_endian(&log.data[..32]);
    Some((from, to, value))
}

/// Indexes `ReceivedTransferRemote` events across multiple CrossCollateralRouter
/// contracts on a single chain and assembles same-chain swap records.
#[derive(Debug)]
pub struct CcrSwapIndexer<M>
where
    M: Middleware,
{
    provider: Arc<M>,
    /// Local domain ID of this chain
    local_domain: u32,
    /// All CCR contract addresses on this chain
    ccr_addresses: Vec<EthersH160>,
    /// Map from CCR address to its underlying ERC20 token address (from registry)
    ccr_to_erc20: HashMap<EthersH160, EthersH160>,
    reorg_period: EthereumReorgPeriod,
}

impl<M> CcrSwapIndexer<M>
where
    M: Middleware + 'static,
{
    pub fn new(
        provider: Arc<M>,
        local_domain: u32,
        ccr_addresses: Vec<H160>,
        ccr_to_erc20: HashMap<H160, H160>,
        reorg_period: EthereumReorgPeriod,
    ) -> Self {
        Self {
            provider,
            local_domain,
            ccr_addresses: ccr_addresses.into_iter().map(Into::into).collect(),
            ccr_to_erc20: ccr_to_erc20
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            reorg_period,
        }
    }

    /// For a same-chain `ReceivedTransferRemote` log, fetch the tx receipt and
    /// find the ERC20 Transfer log where `to` is a known CCR address to
    /// identify the source router and sent amount.
    async fn find_source(
        &self,
        tx_hash: EthersH256,
        destination_router: EthersH160,
    ) -> ChainResult<Option<(EthersH160, U256)>> {
        let receipt = self
            .provider
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let Some(receipt) = receipt else {
            return Ok(None);
        };

        let result = receipt.logs.iter().find_map(|log| {
            let (_, to, value) = decode_erc20_transfer(log)?;
            // `to` must be a known CCR address other than the destination router
            if self.ccr_to_erc20.contains_key(&to) && to != destination_router {
                Some((to, value))
            } else {
                None
            }
        });

        Ok(result)
    }
}

#[async_trait]
impl<M> Indexer<SameChainCcrSwap> for CcrSwapIndexer<M>
where
    M: Middleware + 'static,
{
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<SameChainCcrSwap>, LogMeta)>> {
        let filter = Filter::new()
            .address(self.ccr_addresses.clone())
            .topic0(received_transfer_remote_topic())
            .from_block(*range.start())
            .to_block(*range.end());

        let logs = self
            .provider
            .get_logs(&filter)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let mut results = Vec::new();

        for log in logs {
            let Some((origin, recipient, amount_received)) = decode_received_transfer_remote(&log)
            else {
                continue;
            };

            // Only index same-chain swaps
            if origin != self.local_domain {
                continue;
            }

            let destination_router: EthersH160 = log.address;
            let tx_hash: EthersH256 = match log.transaction_hash {
                Some(h) => h,
                None => continue,
            };

            let Some((source_router, amount_sent)) =
                self.find_source(tx_hash, destination_router).await?
            else {
                continue;
            };

            let log_meta: LogMeta = EthersLogMeta::from(&log).into();

            let mut src_bytes = [0u8; 32];
            src_bytes[12..].copy_from_slice(&source_router.0);
            let mut dst_bytes = [0u8; 32];
            dst_bytes[12..].copy_from_slice(&destination_router.0);

            let swap = SameChainCcrSwap {
                domain: self.local_domain,
                source_router: H256::from(src_bytes),
                destination_router: H256::from(dst_bytes),
                amount_sent,
                amount_received,
                recipient,
            };

            results.push((Indexed::new(swap), log_meta));
        }

        Ok(results)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.provider, &self.reorg_period).await
    }
}

#[async_trait]
impl<M> SequenceAwareIndexer<SameChainCcrSwap> for CcrSwapIndexer<M>
where
    M: Middleware + 'static,
{
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}

/// Builder for `CcrSwapIndexer`. Carries the CCR config so it can be passed
/// through `BuildableWithProvider` (which only exposes the ethers provider).
pub struct CcrSwapIndexerBuilder {
    pub local_domain: u32,
    pub ccr_addresses: Vec<H160>,
    pub ccr_to_erc20: HashMap<H160, H160>,
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for CcrSwapIndexerBuilder {
    type Output = Box<dyn SequenceAwareIndexer<SameChainCcrSwap>>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        _locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(CcrSwapIndexer::new(
            Arc::new(provider),
            self.local_domain,
            self.ccr_addresses.clone(),
            self.ccr_to_erc20.clone(),
            self.reorg_period,
        ))
    }
}
