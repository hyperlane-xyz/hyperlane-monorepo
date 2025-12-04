use std::collections::HashMap;
use std::{ops::RangeInclusive, str::FromStr};

use aleo_serialize::AleoSerialize;
use futures::future;
use hyperlane_core::{ChainResult, Indexed, LogMeta, H512};
use snarkvm::ledger::Block;
use snarkvm::prelude::{CanaryV0, Itertools, MainnetV0, Network, TestnetV0};
use snarkvm::{
    prelude::{Identifier, Plaintext, ProgramID},
    synthesizer::program::FinalizeOperation,
};

use crate::provider::AleoClient;
use crate::utils::{get_tx_id, to_h256, to_key_id};
use crate::{AleoProvider, HyperlaneAleoError};

pub(crate) trait AleoIndexer {
    const INDEX_MAPPING: &str;
    const VALUE_MAPPING: &str;
    type AleoType: AleoSerialize<TestnetV0>
        + AleoSerialize<MainnetV0>
        + AleoSerialize<CanaryV0>
        + Into<Self::Type>;
    type Type;

    fn get_provider(&self) -> &AleoProvider<impl AleoClient>;

    fn get_program(&self) -> &str;

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_provider().get_latest_height().await
    }

    /// Returns the mapping key to index into the event mapping
    /// For simple u32 indexed mappings, this is just the index as a plaintext
    /// For hook indexed mappings, this is a struct with hook address and index
    fn get_mapping_key<N: Network>(&self, index: u32) -> ChainResult<Plaintext<N>> {
        Ok(index.to_plaintext().map_err(HyperlaneAleoError::from)?)
    }

    /// Returns the latest event index of that specific block
    /// This index represents the last sequence number of events emitted in that block
    /// Meaning if there were 3 events emitted in that block and sequence was 5 before, the latest event index would be 8
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<Option<u32>> {
        self.get_provider()
            .get_mapping_value(self.get_program(), Self::INDEX_MAPPING, &height)
            .await
    }

    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>> {
        match self.get_provider().chain_id() {
            MainnetV0::ID => self.fetch_network_logs_in_range::<MainnetV0>(range).await,
            TestnetV0::ID => self.fetch_network_logs_in_range::<TestnetV0>(range).await,
            CanaryV0::ID => self.fetch_network_logs_in_range::<CanaryV0>(range).await,
            id => Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        }
    }

    async fn fetch_network_logs_in_range<N: Network>(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>>
    where
        Self::AleoType: AleoSerialize<N>,
    {
        // First fetch all blocks that contain relevant logs
        let relevant_blocks = range
            .map(|height| async move {
                let latest_index = self.get_latest_event_index(height).await;
                latest_index.map(|latest_index| (height, latest_index))
            })
            .collect_vec();

        let relevant_blocks = future::join_all(relevant_blocks)
            .await
            .into_iter()
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            // We are just interested in blocks that have events
            // So we filter out blocks where the result is None
            .filter_map(|(height, latest_event_index)| {
                latest_event_index.map(|index| (height, index))
            })
            .collect_vec();

        let block_logs_futures = relevant_blocks
            .into_iter()
            .map(|(height, latest_event_index)| async move {
                let block = self.get_provider().get_block::<N>(height).await?;
                self.get_logs_for_block(block, latest_event_index, None)
                    .await
            })
            .collect_vec();
        let result = future::join_all(block_logs_futures)
            .await
            .into_iter()
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok(result)
    }

    /// Fetch list of logs from a tx hash
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>> {
        match self.get_provider().chain_id() {
            MainnetV0::ID => self.get_logs_for_tx::<MainnetV0>(tx_hash).await,
            CanaryV0::ID => self.get_logs_for_tx::<CanaryV0>(tx_hash).await,
            TestnetV0::ID => self.get_logs_for_tx::<TestnetV0>(tx_hash).await,
            id => Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        }
    }

    async fn get_logs_for_tx<N: Network>(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>>
    where
        Self::AleoType: AleoSerialize<N>,
    {
        if tx_hash.is_zero() {
            return Ok(vec![]);
        }
        let tx_id = get_tx_id::<N>(tx_hash)?;
        let hash = self
            .get_provider()
            .find_block_hash_by_transaction_id::<N>(&tx_id)
            .await?;
        let block = self.get_provider().get_block_by_hash::<N>(&hash).await?;
        let latest_event_index = self
            .get_latest_event_index(block.metadata().height())
            .await?;
        match latest_event_index {
            Some(index) => self.get_logs_for_block(block, index, Some(tx_id)).await,
            None => Ok(vec![]),
        }
    }

    /// Fetch logs for a specific block
    /// If tx_id is provided, only logs from that transaction are returned
    async fn get_logs_for_block<N: Network>(
        &self,
        block: Block<N>,
        last_event_index: u32,
        tx_id: Option<N::TransactionID>,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>>
    where
        Self::AleoType: AleoSerialize<N>,
    {
        let height = block.metadata().height();
        let program_id =
            ProgramID::from_str(self.get_program()).map_err(HyperlaneAleoError::from)?;
        let program_address = program_id.to_address().map_err(HyperlaneAleoError::from)?;

        let mapping_name =
            Identifier::<N>::from_str(Self::VALUE_MAPPING).map_err(HyperlaneAleoError::from)?;

        let transitions = block
            .clone()
            .into_transitions()
            .filter(|x| *x.program_id() == program_id)
            .collect_vec();

        // Early return if no transitions found
        if transitions.is_empty() {
            return Ok(Default::default());
        }

        // Aleo doesn't provide an easy way to map from transition to mapping key
        // It only provides a hash of that mapping key
        // Therefore, we precompute all possible mapping keys for the events in this block
        // and map them by their key id (hash)
        // Because we know the latest event index and the number of transitions in this block
        // We can compute the possible event indices and their corresponding mapping keys
        let possible_key_ids: HashMap<_, _> = (0..transitions.len())
            .map(|i| {
                let index = last_event_index.saturating_sub(i as u32);
                let plain_key = self.get_mapping_key(index)?;
                to_key_id(&program_id, &mapping_name, &plain_key)
                    .map(|key_id| (key_id, (index, plain_key)))
            })
            .collect::<ChainResult<_>>()?;

        let mut logs = HashMap::with_capacity(possible_key_ids.len());

        for transition in transitions {
            // Check that the corresponding transaction is executed and didn't get reverted
            let transaction = block
                .find_transaction_for_transition_id(transition.id())
                .and_then(|tx| block.get_confirmed_transaction(&tx.id()));
            let transaction = match transaction {
                Some(v) => v,
                None => continue,
            };

            // If a specific tx_id is provided, skip other transactions
            if let Some(tx_id) = tx_id {
                if transaction.id() != tx_id {
                    continue;
                }
            }

            let mut event_indices = HashMap::<u32, Plaintext<N>>::new();
            for operation in transaction.finalize_operations().iter() {
                match operation {
                    // We are only interested in mapping insert/update operations
                    // As these are the only operations of the contracts
                    FinalizeOperation::InsertKeyValue(_, key, _)
                    | FinalizeOperation::UpdateKeyValue(_, key, _) => {
                        if let Some((index, plain_key)) = possible_key_ids.get(key) {
                            event_indices
                                .entry(*index)
                                .or_insert_with(|| plain_key.clone());
                        }
                    }
                    _ => continue,
                }
            }

            // At this point we have recovered all event indices emitted in this transaction
            // We can now fetch the event data from the mapping using these indices
            for (index, key) in event_indices {
                let event: Self::AleoType = self
                    .get_provider()
                    .get_mapping_value_raw(self.get_program(), Self::VALUE_MAPPING, &key)
                    .await?;
                let indexed = Indexed::<Self::Type>::new(event.into()).with_sequence(index);
                let meta: LogMeta = LogMeta {
                    address: to_h256(program_address)?,
                    block_number: height.into(),
                    block_hash: to_h256(block.hash())?,
                    transaction_id: to_h256(transaction.id())?.into(),
                    transaction_index: transaction.index().into(),
                    log_index: index.into(),
                };
                logs.entry(index).or_insert_with(|| (indexed, meta));
            }
        }
        Ok(logs.into_values().collect())
    }
}
