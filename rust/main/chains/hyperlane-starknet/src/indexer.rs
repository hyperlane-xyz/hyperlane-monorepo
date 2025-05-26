use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneMessage, Indexed, Indexer, InterchainGasPayment,
    LogMeta, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, U256,
};
use starknet::core::types::{BlockId, EventFilter, FieldElement};
use starknet::core::utils::get_selector_from_name;
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{AnyProvider, JsonRpcClient, Provider};
use std::fmt::Debug;
use std::ops::RangeInclusive;
use tracing::instrument;

use crate::contracts::mailbox::MailboxReader as StarknetMailboxReader;
use crate::contracts::merkle_tree_hook::MerkleTreeHookReader as StarknetMerkleTreeHookReader;
use crate::types::HyH256;
use crate::{
    get_block_height_u32, try_parse_hyperlane_message_from_event, ConnectionConf,
    HyperlaneStarknetError,
};

const CHUNK_SIZE: u64 = 50;

#[derive(Debug)]
/// Starknet Mailbox Indexer
pub struct StarknetMailboxIndexer {
    contract: StarknetMailboxReader<AnyProvider>,
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
            contract,
            reorg_period: reorg_period.clone(),
        })
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for StarknetMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_block_height_u32(&self.contract.provider, &self.reorg_period).await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        fetch_logs_in_range(
            &self.contract.provider,
            range,
            self.contract.address,
            "Dispatch",
            try_parse_hyperlane_message_from_event,
        )
        .await
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
        get_block_height_u32(&self.contract.provider, &self.reorg_period).await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        fetch_logs_in_range(
            &self.contract.provider,
            range,
            self.contract.address,
            "ProcessId",
            |event| {
                if event.data.len() < 2 {
                    return Err(HyperlaneStarknetError::InvalidEventData(format!(
                        "{}",
                        event.transaction_hash
                    ))
                    .into());
                }
                let message_id: HyH256 = (event.data[0], event.data[1])
                    .try_into()
                    .map_err(Into::<HyperlaneStarknetError>::into)
                    .unwrap();
                let message_id: Indexed<H256> = message_id.0.into();
                Ok(message_id)
            },
        )
        .await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for StarknetMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}

#[derive(Debug)]
/// Starknet MerkleTreeHook Indexer
pub struct StarknetMerkleTreeHookIndexer {
    contract: StarknetMerkleTreeHookReader<AnyProvider>,
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
            contract,
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
        fetch_logs_in_range(
            &self.contract.provider,
            range,
            self.contract.address,
            "InsertedIntoTree",
            |event| {
                if event.data.len() < 3 {
                    return Err(HyperlaneStarknetError::InvalidEventData(format!(
                        "{}",
                        event.transaction_hash
                    ))
                    .into());
                }
                let leaf_index: u32 = event.data[2]
                    .try_into()
                    .map_err(Into::<HyperlaneStarknetError>::into)?;
                let message_id: HyH256 = (event.data[0], event.data[1])
                    .try_into()
                    .map_err(Into::<HyperlaneStarknetError>::into)?;

                let merkle_tree_insertion =
                    MerkleTreeInsertion::new(leaf_index, message_id.0).into();

                Ok(merkle_tree_insertion)
            },
        )
        .await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_block_height_u32(&self.contract.provider, &self.reorg_period).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for StarknetMerkleTreeHookIndexer {
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

/// TODO: This is a placeholder for the Interchain Gas Paymaster indexer.
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

/// Fetch logs in the given range
async fn fetch_logs_in_range<T>(
    provider: &AnyProvider,
    range: RangeInclusive<u32>,
    address: FieldElement,
    key: &str,
    parse: fn(&starknet::core::types::EmittedEvent) -> ChainResult<Indexed<T>>,
) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
where
    T: std::fmt::Debug,
{
    let key = get_selector_from_name(key)
        .map_err(|_| HyperlaneStarknetError::from_other("get selector cannot fail"))?;

    let filter = EventFilter {
        from_block: Some(BlockId::Number((*range.start()).into())),
        to_block: Some(BlockId::Number((*range.end()).into())),
        address: Some(address),
        keys: Some(vec![vec![key]]),
    };

    // fetch all events in the range
    // chunk_size is quite limited, so we need to fetch multiple pages
    let mut token = None;
    let mut events = vec![];

    loop {
        let page = provider
            .get_events(filter.clone(), token.clone(), CHUNK_SIZE)
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        events.extend(page.events);
        match page.continuation_token {
            Some(next_token) => token = Some(next_token),
            None => break,
        }
    }

    events
        .into_iter()
        .map(|event| {
            let parsed_event = parse(&event)?;

            let block_hash = event
                .block_hash
                .ok_or(HyperlaneStarknetError::InvalidBlock)?;
            let block_number = event
                .block_number
                .ok_or(HyperlaneStarknetError::InvalidBlock)?;

            let meta = LogMeta {
                address: H256::from_slice(event.from_address.to_bytes_be().as_slice()),
                block_number,
                block_hash: H256::from_slice(block_hash.to_bytes_be().as_slice()),
                transaction_id: H256::from_slice(event.transaction_hash.to_bytes_be().as_slice())
                    .into(),
                transaction_index: 0u64,
                log_index: U256::zero(),
            };
            Ok((parsed_event, meta))
        })
        .collect()
}
