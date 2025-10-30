use std::{ops::RangeInclusive, str::FromStr, sync::OnceLock};

use aleo_serialize::AleoSerialize;
use futures::future;
use hyperlane_core::{ChainResult, Indexed, LogMeta, H256, H512};
use snarkvm::prelude::Itertools;
use snarkvm::{
    ledger::Block,
    prelude::{Identifier, Literal, Plaintext, ProgramID, U32},
    synthesizer::program::FinalizeOperation,
};

use crate::{get_tx_id, to_h256, to_key_id, AleoMessage, AleoProvider, CurrentNetwork};

mod delivery;
mod dispatch;
mod interchain_gas;
mod merkle_tree_hook;

pub use delivery::*;
pub use dispatch::*;
pub use interchain_gas::*;
pub use merkle_tree_hook::*;

pub(crate) trait AleoIndexer {
    const INDEX_MAPPING: &str;
    const VALUE_MAPPING: &str;
    type AleoType: AleoSerialize<CurrentNetwork> + Into<Self::Type>;
    type Type;

    fn get_client(&self) -> &AleoProvider;

    fn get_program(&self) -> &str;

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_client().get_latest_height().await
    }

    /// Returns the event value of a mapping
    fn get_mapping_key(&self, index: u32) -> ChainResult<Plaintext<CurrentNetwork>> {
        // Default is just a literal of that u32, however this might change with different mapping values like for the IGP or MTH
        Ok(Plaintext::Literal(
            Literal::U32(U32::<CurrentNetwork>::new(index)),
            OnceLock::new(),
        ))
    }

    /// Returns the lastest event index of that specific block
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<u32> {
        let last_event_index: U32<CurrentNetwork> = self
            .get_client()
            .get_mapping_value(
                self.get_program(),
                Self::INDEX_MAPPING,
                &format!("{}u32", height),
            )
            .await?;
        Ok(*last_event_index)
    }

    /// Fetch list of logs from a tx hash
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>> {
        if tx_hash.is_zero() {
            return Ok(vec![]);
        }
        let tx_id = get_tx_id(tx_hash)?;
        let tx_id = tx_id.to_string();
        let hash = self
            .get_client()
            .find_block_hash_by_transaction_id(&tx_id)
            .await?;
        let block = self.get_client().get_block_by_hash(&hash).await?;
        self.get_logs_for_block(block).await
    }

    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>> {
        let block_futures = range.map(|x| self.get_client().get_block(x)).collect_vec();
        let block_logs_futures = future::join_all(block_futures)
            .await
            .into_iter()
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            .map(|block| self.get_logs_for_block(block))
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

    async fn get_logs_for_block(
        &self,
        block: Block<CurrentNetwork>,
    ) -> ChainResult<Vec<(Indexed<Self::Type>, LogMeta)>> {
        let height = block.metadata().height();
        // The program is the target contract
        // TODO: error handling
        let program_id = ProgramID::from_str(self.get_program()).unwrap();
        let mapping_name = Identifier::<CurrentNetwork>::from_str(Self::VALUE_MAPPING).unwrap();

        // Get the total number of transitions that interacted with the given program
        let transitions = block
            .clone()
            .into_transitions()
            .filter(|x| *x.program_id() == program_id)
            .collect_vec();

        // Early return if we don't have any relevant transitions
        if transitions.len() == 0 {
            return Ok(Default::default());
        }

        let last_event_index = self.get_latest_event_index(height).await?;

        // Calculate every possible key id based on the number of transitions and the final event index
        let possible_key_ids: std::collections::HashMap<_, _> = (0..transitions.len())
            .map(|i| {
                let index = last_event_index.saturating_sub(i as u32);
                let plain_key = self.get_mapping_key(index)?;
                to_key_id(&program_id, &mapping_name, &plain_key)
                    .map(|key_id| (key_id, (index, plain_key)))
            })
            .collect::<ChainResult<_>>()?;

        let mut logs = Vec::with_capacity(transitions.len());

        for transition in transitions {
            let transaction = block
                .find_transaction_for_transition_id(transition.id())
                .unwrap();
            let transaction = block.get_confirmed_transaction(&transaction.id());

            // Skip unconfirmed tx
            if transaction.is_none() {
                continue;
            }
            let transaction = transaction.unwrap();

            // Get the event indicies for this specific transaction
            let event_indicies = transaction
                .finalize_operations()
                .iter()
                .filter_map(|operation| match operation {
                    FinalizeOperation::InsertKeyValue(_, key, _) => {
                        // check if the operation interacted with our desired mapping id
                        return possible_key_ids.get(key);
                    }
                    FinalizeOperation::UpdateKeyValue(_, key, _) => {
                        return possible_key_ids.get(key)
                    }
                    _ => None,
                })
                .collect_vec();

            // Get the mapping value id of the events that is dispatched in this transaction
            for (index, key) in event_indicies {
                let event: Self::AleoType = self
                    .get_client()
                    .get_mapping_value(self.get_program(), Self::VALUE_MAPPING, &key.to_string())
                    .await?;
                let indexed = Indexed::<Self::Type>::new(event.into()).with_sequence(*index);
                let meta: LogMeta = LogMeta {
                    address: H256::zero(), // TODO: convert the program_id to a filed and finally to bytes
                    block_number: height.into(),
                    block_hash: to_h256(block.hash())?,
                    transaction_id: to_h256(transaction.id())?.into(),
                    transaction_index: transaction.index().into(),
                    log_index: hyperlane_core::U256::zero(),
                };
                logs.push((indexed, meta))
            }
        }
        Ok(logs)
    }
}
