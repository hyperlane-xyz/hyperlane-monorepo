use std::collections::{HashMap, HashSet};
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use ethers::types::{Filter, Log, TransactionReceipt, H160 as EthersH160, H256 as EthersH256};
use ethers_contract::LogMeta as EthersLogMeta;
use ethers_core::utils::keccak256;
use futures_util::{stream, StreamExt, TryStreamExt};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    SameChainCcrSwap, H160, H256, U256,
};

use super::utils::get_finalized_block_number;
use crate::{BuildableWithProvider, ConnectionConf, EthereumReorgPeriod};

fn received_transfer_remote_topic() -> EthersH256 {
    EthersH256::from(keccak256(b"ReceivedTransferRemote(uint32,bytes32,uint256)"))
}

/// Decode a `ReceivedTransferRemote` log. Returns `None` if the log doesn't match.
fn decode_received_transfer_remote(log: &Log) -> Option<(u32, H256, U256)> {
    if log.topics.first() != Some(&received_transfer_remote_topic()) {
        return None;
    }
    let origin = u32::from_be_bytes(log.topics.get(1)?[28..32].try_into().ok()?);
    let recipient = H256::from(log.topics.get(2)?.0);
    if log.data.len() < 32 {
        return None;
    }
    let amount = U256::from_big_endian(&log.data[..32]);
    Some((origin, recipient, amount))
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
    /// Set of known collateral ERC20 addresses — pre-built for fast log pre-filtering
    known_collaterals: HashSet<EthersH160>,
    /// Maps each CCR router's topic2 representation (address left-padded to 32 bytes)
    /// to its paired collateral ERC20 address — used to verify router→collateral pairs
    ccr_router_topics: HashMap<EthersH256, EthersH160>,
    /// Cached topic0 for ERC20 Transfer — computed once at construction
    erc20_transfer_topic: EthersH256,
    reorg_period: EthereumReorgPeriod,
}

impl<M> CcrSwapIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create a new `CcrSwapIndexer`.
    pub fn new(
        provider: Arc<M>,
        local_domain: u32,
        ccr_to_erc20: HashMap<H160, H160>,
        reorg_period: EthereumReorgPeriod,
    ) -> Self {
        let ccr_to_erc20: HashMap<EthersH160, EthersH160> = ccr_to_erc20
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        let known_collaterals = ccr_to_erc20.values().copied().collect();
        let ccr_addresses: Vec<EthersH160> = ccr_to_erc20.keys().copied().collect();
        let ccr_router_topics = ccr_to_erc20
            .iter()
            .map(|(addr, collateral)| {
                let mut topic = EthersH256::zero();
                topic.0[12..].copy_from_slice(&addr.0);
                (topic, *collateral)
            })
            .collect();
        Self {
            provider,
            local_domain,
            ccr_addresses,
            known_collaterals,
            ccr_router_topics,
            erc20_transfer_topic: EthersH256::from(keccak256(b"Transfer(address,address,uint256)")),
            reorg_period,
        }
    }

    /// Search a pre-fetched receipt for the ERC20 Transfer that identifies the
    /// source router for a same-chain CCR swap arriving at `destination_router`.
    ///
    /// Scopes the search to logs that precede `rtr_log_index` and returns the
    /// last (highest log-index) match, so that each RTR in a multi-swap transaction
    /// is paired with its own Transfer rather than the first Transfer in the tx.
    fn find_source_in_receipt(
        &self,
        receipt: &TransactionReceipt,
        destination_router: EthersH160,
        rtr_log_index: u64,
    ) -> Option<EthersH160> {
        let mut dst_topic = EthersH256::zero();
        dst_topic.0[12..].copy_from_slice(&destination_router.0);

        receipt
            .logs
            .iter()
            .rev()
            .filter(|log| {
                log.log_index
                    .is_some_and(|idx| idx.as_u64() < rtr_log_index)
            })
            .find_map(|log| {
                // Pre-filter 1: only ERC20 logs from known collateral contracts.
                if !self.known_collaterals.contains(&log.address) {
                    return None;
                }
                // Pre-filter 2: must be an ERC20 Transfer event.
                if log.topics.first() != Some(&self.erc20_transfer_topic) {
                    return None;
                }
                // Compare topic2 (`to`) directly as a 32-byte value — no decoding needed.
                // `to` is the source CCR router: a known CCR address other than the destination.
                // Also verify the Transfer came from that router's paired collateral, not just
                // any known collateral (guards against cross-token transfers matching spuriously).
                let topic2 = log.topics.get(2)?;
                if topic2 == &dst_topic {
                    return None;
                }
                let expected_collateral = self.ccr_router_topics.get(topic2)?;
                if log.address != *expected_collateral {
                    return None;
                }
                Some(EthersH160::from_slice(&topic2.0[12..]))
            })
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

        // Pre-filter logs and collect candidates for receipt lookup.
        struct Candidate {
            log: Log,
            tx_hash: EthersH256,
            /// Log index of the RTR event within the transaction — used to scope
            /// the ERC-20 Transfer search to preceding logs.
            rtr_log_index: u64,
            destination_router: EthersH160,
            recipient: H256,
            amount_received: U256,
        }

        let candidates: Vec<Candidate> = logs
            .into_iter()
            .filter_map(|log| {
                let (origin, recipient, amount_received) = decode_received_transfer_remote(&log)?;
                if origin != self.local_domain {
                    return None;
                }
                let tx_hash = log.transaction_hash?;
                let rtr_log_index = log.log_index?.as_u64();
                Some(Candidate {
                    destination_router: log.address,
                    log,
                    tx_hash,
                    rtr_log_index,
                    recipient,
                    amount_received,
                })
            })
            .collect();

        // Fetch receipts for all unique tx hashes concurrently.
        let unique_hashes: Vec<EthersH256> = candidates
            .iter()
            .map(|c| c.tx_hash)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        const RECEIPT_FETCH_CONCURRENCY: usize = 20;

        let receipts: HashMap<EthersH256, TransactionReceipt> = stream::iter(unique_hashes)
            .map(|tx_hash| {
                let provider = Arc::clone(&self.provider);
                async move {
                    let receipt = provider
                        .get_transaction_receipt(tx_hash)
                        .await
                        .map_err(ChainCommunicationError::from_other)?
                        .ok_or_else(|| {
                            ChainCommunicationError::from_other_str(&format!(
                                "missing receipt for finalized tx {tx_hash:?}"
                            ))
                        })?;
                    Ok::<_, ChainCommunicationError>((tx_hash, receipt))
                }
            })
            .buffer_unordered(RECEIPT_FETCH_CONCURRENCY)
            .try_collect()
            .await?;

        // Assemble swap records using the cached receipts.
        let mut results = Vec::new();
        for c in candidates {
            let Some(receipt) = receipts.get(&c.tx_hash) else {
                return Err(ChainCommunicationError::from_other_str(&format!(
                    "receipt missing from cache for tx {:?} (should be unreachable)",
                    c.tx_hash
                )));
            };
            let Some(source_router) =
                self.find_source_in_receipt(receipt, c.destination_router, c.rtr_log_index)
            else {
                continue;
            };

            let log_meta: LogMeta = EthersLogMeta::from(&c.log).into();

            let mut src_bytes = [0u8; 32];
            src_bytes[12..].copy_from_slice(&source_router.0);
            let mut dst_bytes = [0u8; 32];
            dst_bytes[12..].copy_from_slice(&c.destination_router.0);

            let swap = SameChainCcrSwap {
                domain: self.local_domain,
                source_router: H256::from(src_bytes),
                destination_router: H256::from(dst_bytes),
                amount_received: c.amount_received,
                recipient: c.recipient,
            };

            results.push((Indexed::new(swap), log_meta));
        }

        Ok(results)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.provider, &self.reorg_period).await
    }
}

/// Builder for `CcrSwapIndexer`. Carries the CCR config so it can be passed
/// through `BuildableWithProvider` (which only exposes the ethers provider).
pub struct CcrSwapIndexerBuilder {
    /// Local domain ID of the chain being indexed.
    pub local_domain: u32,
    /// Map of CCR router address → collateral ERC20 address for this chain.
    pub ccr_to_erc20: HashMap<H160, H160>,
    /// Reorg safety period for this chain.
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for CcrSwapIndexerBuilder {
    type Output = Box<dyn Indexer<SameChainCcrSwap>>;
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
            self.ccr_to_erc20.clone(),
            self.reorg_period,
        ))
    }
}
