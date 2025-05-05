use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneMessage, Indexed, Indexer,
    InterchainGasPayment, LogMeta, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256,
    U256,
};
use starknet::core::types::{
    BlockId, BlockTag, EventFilter, FieldElement, MaybePendingBlockWithTxHashes,
    MaybePendingBlockWithTxs,
};
use starknet::core::utils::get_selector_from_name;
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{AnyProvider, JsonRpcClient, Provider};
use std::fmt::Debug;
use std::ops::RangeInclusive;
use std::sync::Arc;
use tracing::instrument;

use crate::contracts::mailbox::MailboxReader as StarknetMailboxReader;
use crate::contracts::merkle_tree_hook::MerkleTreeHookReader as StarknetMerkleTreeHookReader;
use crate::types::HyH256;
use crate::{try_parse_hyperlane_message_from_event, ConnectionConf, HyperlaneStarknetError};

#[derive(Debug)]
/// Starknet RPC Provider
pub struct StarknetMailboxIndexer {
    contract: Arc<StarknetMailboxReader<AnyProvider>>,
    reorg_period: ReorgPeriod,
}

impl StarknetMailboxIndexer {
    /// create new Starknet Mailbox Indexer
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<Self> {
        let rpc_client =
            AnyProvider::JsonRpcHttp(JsonRpcClient::new(HttpTransport::new(conf.url.clone())));
        let contract = StarknetMailboxReader::new(
            FieldElement::from_bytes_be(&locator.address.to_fixed_bytes()).unwrap(),
            rpc_client,
        );

        Ok(Self {
            contract: Arc::new(contract),
            reorg_period: reorg_period.clone(),
        })
    }

    #[allow(unused)]
    async fn get_block(&self, block_number: u32) -> ChainResult<MaybePendingBlockWithTxHashes> {
        Ok(self
            .contract
            .provider
            .get_block_with_tx_hashes(BlockId::Number(block_number as u64))
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?)
    }

    #[allow(unused)]
    async fn get_block_results(&self, block_number: u32) -> ChainResult<MaybePendingBlockWithTxs> {
        Ok(self
            .contract
            .provider
            .get_block_with_txs(BlockId::Number(block_number as u64))
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?)
    }

    #[allow(unused)]
    async fn get_latest_block(&self) -> ChainResult<MaybePendingBlockWithTxHashes> {
        Ok(self
            .contract
            .provider
            .get_block_with_tx_hashes(BlockId::Tag(BlockTag::Latest))
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        match self.reorg_period {
            ReorgPeriod::None => {
                // Fetch the block number first
                let block_number_u64 = self
                    .contract
                    .provider
                    .block_number()
                    .await
                    .map_err(Into::<HyperlaneStarknetError>::into)?;
                // Now attempt the conversion u64->u32 and map the error
                block_number_u64.try_into().map_err(|_| {
                    ChainCommunicationError::from_other(
                        HyperlaneStarknetError::BlockNumberOverflow(block_number_u64),
                    )
                })
            }
            ReorgPeriod::Blocks(reorg_period) => {
                let block_number_u64 = self
                    .contract
                    .provider
                    .block_number()
                    .await
                    .map_err(Into::<HyperlaneStarknetError>::into)?;
                // Now attempt the conversion u64->u32 and map the error
                block_number_u64
                    .saturating_sub(reorg_period.get() as u64)
                    .try_into()
                    .map_err(|_| {
                        ChainCommunicationError::from_other(
                            HyperlaneStarknetError::BlockNumberOverflow(block_number_u64),
                        )
                    })
            }
            ReorgPeriod::Tag(_) => {
                Err(hyperlane_core::ChainCommunicationError::InvalidReorgPeriod(
                    self.reorg_period.clone(),
                ))
            }
        }
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for StarknetMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let key = get_selector_from_name("Dispatch")
            .map_err(|_| HyperlaneStarknetError::Other("get selector cannot fail".to_string()))?;

        let filter = EventFilter {
            from_block: Some(BlockId::Number((*range.start()).into())),
            to_block: Some(BlockId::Number((*range.end()).into())),
            address: Some(self.contract.address),
            keys: Some(vec![vec![key]]),
        };

        let chunk_size = range.end() - range.start() + 1;

        let mut events: Vec<(Indexed<HyperlaneMessage>, LogMeta)> = self
            .contract
            .provider
            .get_events(filter, None, chunk_size.into())
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?
            .events
            .into_iter()
            .map(|event| {
                let message = try_parse_hyperlane_message_from_event(&event)
                    .map_err(|e| {
                        HyperlaneStarknetError::Other(format!("Failed to parse message: {}", e))
                    })?
                    .into();

                let block_number = event
                    .block_number
                    .ok_or_else(|| HyperlaneStarknetError::InvalidBlock)?;

                let block_hash = event
                    .block_hash
                    .ok_or_else(|| HyperlaneStarknetError::InvalidBlock)?;

                let meta = LogMeta {
                    address: H256::from_slice(event.from_address.to_bytes_be().as_slice()),
                    block_number,
                    block_hash: H256::from_slice(block_hash.to_bytes_be().as_slice()),
                    transaction_id: H256::from_slice(
                        event.transaction_hash.to_bytes_be().as_slice(),
                    )
                    .into(),
                    transaction_index: 0,
                    log_index: U256::one(),
                };
                Ok((message, meta))
            })
            .collect::<Result<Vec<_>, HyperlaneStarknetError>>()?;

        events.sort_by(|a, b| a.0.inner().nonce.cmp(&b.0.inner().nonce));

        Ok(events)
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for StarknetMailboxIndexer {
    #[instrument(err, skip(self))]
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self).await?;

        let sequence = self
            .contract
            .nonce()
            .block_id(BlockId::Number(tip as u64))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok((Some(sequence), tip))
    }
}

#[async_trait]
impl Indexer<H256> for StarknetMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let key = get_selector_from_name("DispatchId").unwrap(); // safe to unwrap

        let filter = EventFilter {
            from_block: Some(BlockId::Number((*range.start()).into())),
            to_block: Some(BlockId::Number((*range.end()).into())),
            address: Some(self.contract.address),
            keys: Some(vec![vec![key]]),
        };

        let chunk_size = range.end() - range.start() + 1;

        let events: Vec<(Indexed<H256>, LogMeta)> = self
            .contract
            .provider
            .get_events(filter, None, chunk_size.into())
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?
            .events
            .into_iter()
            .map(|event| {
                let message_id: HyH256 = (event.data[0], event.data[1])
                    .try_into()
                    .map_err(Into::<HyperlaneStarknetError>::into)
                    .unwrap();
                let message_id: Indexed<H256> = message_id.0.into();
                let meta = LogMeta {
                    address: H256::from_slice(event.from_address.to_bytes_be().as_slice()),
                    block_number: event.block_number.unwrap(),
                    block_hash: H256::from_slice(
                        event.block_hash.unwrap().to_bytes_be().as_slice(),
                    ),
                    transaction_id: H256::from_slice(
                        event.transaction_hash.to_bytes_be().as_slice(),
                    )
                    .into(),
                    transaction_index: 0,   // TODO: what to put here?
                    log_index: U256::one(), // TODO: what to put here?
                };
                (message_id, meta)
            })
            .collect();

        Ok(events)
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for StarknetMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // A blanket implementation for this trait is fine for the EVM.
        // TODO: Consider removing `Indexer` as a supertrait of `SequenceAwareIndexer`
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}

#[derive(Debug)]
/// Starknet RPC Provider
pub struct StarknetMerkleTreeHookIndexer {
    contract: Arc<StarknetMerkleTreeHookReader<AnyProvider>>,
    reorg_period: ReorgPeriod,
}

impl StarknetMerkleTreeHookIndexer {
    /// create new Starknet MerkleTreeHook Indexer
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<Self> {
        let rpc_client =
            AnyProvider::JsonRpcHttp(JsonRpcClient::new(HttpTransport::new(conf.url.clone())));
        let contract = StarknetMerkleTreeHookReader::new(
            FieldElement::from_bytes_be(&locator.address.to_fixed_bytes()).unwrap(),
            rpc_client,
        );

        Ok(Self {
            contract: Arc::new(contract),
            reorg_period: reorg_period.clone(),
        })
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for StarknetMerkleTreeHookIndexer {
    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let key = get_selector_from_name("InsertedIntoTree").unwrap(); // safe to unwrap

        let filter = EventFilter {
            from_block: Some(BlockId::Number((*range.start()).into())),
            to_block: Some(BlockId::Number((*range.end()).into())),
            address: Some(self.contract.address),
            keys: Some(vec![vec![key]]),
        };

        let chunk_size = range.end() - range.start() + 1;

        let events: Result<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>, HyperlaneStarknetError> =
            self.contract
                .provider
                .get_events(filter, None, chunk_size.into())
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?
                .events
                .into_iter()
                .map(|event| {
                    let leaf_index: u32 = event.data[2]
                        .try_into()
                        .map_err(Into::<HyperlaneStarknetError>::into)?;
                    let message_id: HyH256 = (event.data[0], event.data[1])
                        .try_into()
                        .map_err(Into::<HyperlaneStarknetError>::into)?;

                    let merkle_tree_insertion =
                        MerkleTreeInsertion::new(leaf_index, message_id.0).into();

                    let meta = LogMeta {
                        address: H256::from_slice(event.from_address.to_bytes_be().as_slice()),
                        block_number: event.block_number.unwrap(),
                        block_hash: H256::from_slice(
                            event.block_hash.unwrap().to_bytes_be().as_slice(),
                        ),
                        transaction_id: H256::from_slice(
                            event.transaction_hash.to_bytes_be().as_slice(),
                        )
                        .into(),
                        transaction_index: 0,   // TODO: what to put here?
                        log_index: U256::one(), // TODO: what to put here?
                    };
                    Ok((merkle_tree_insertion, meta))
                })
                .collect();

        Ok(events?)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        match self.reorg_period {
            ReorgPeriod::None => Ok(
                self.contract
                    .provider
                    .block_number()
                    .await
                    .map_err(Into::<HyperlaneStarknetError>::into)?
                    .try_into()
                    .unwrap(), // TODO: check if safe
            ),
            ReorgPeriod::Blocks(reorg_period) => Ok(
                self.contract
                    .provider
                    .block_number()
                    .await
                    .map_err(Into::<HyperlaneStarknetError>::into)?
                    .saturating_sub(reorg_period.get() as u64)
                    .try_into()
                    .unwrap(), // TODO: check if safe
            ),
            ReorgPeriod::Tag(_) => {
                Err(hyperlane_core::ChainCommunicationError::InvalidReorgPeriod(
                    self.reorg_period.clone(),
                ))
            }
        }
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for StarknetMerkleTreeHookIndexer {
    // TODO: if `SequenceAwareIndexer` turns out to not depend on `Indexer` at all, then the supertrait
    // dependency could be removed, even if the builder would still need to return a type that is both
    // `SequenceAwareIndexer` and `Indexer`.
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self
            .contract
            .count()
            .block_id(starknet::core::types::BlockId::Number(u64::from(tip)))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok((Some(sequence), tip))
    }
}

/// Interchain Gas Paymaster

/// A reference to a InterchainGasPaymasterIndexer contract on some Starknet chain
#[derive(Debug, Clone)]
pub struct StarknetInterchainGasPaymasterIndexer {}

#[async_trait]
impl Indexer<InterchainGasPayment> for StarknetInterchainGasPaymasterIndexer {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        Ok(Default::default())
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(0)
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for StarknetInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
