use std::{num::NonZeroU64, ops::RangeInclusive};

use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    HyperlaneChain, HyperlaneMessage, Indexed, Indexer, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, SequenceAwareIndexer,
};
use hyperlane_sealevel_mailbox::accounts::OutboxAccount;
use solana_sdk::commitment_config::CommitmentConfig;
use tracing::instrument;

use crate::{SealevelMailbox, SealevelMailboxIndexer};

#[async_trait]
impl MerkleTreeHook for SealevelMailbox {
    #[instrument(err, ret, skip(self))]
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        assert!(
            lag.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let outbox_account = self
            .rpc()
            .get_account_with_commitment(&self.outbox.0, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find account data")
            })?;
        let outbox = OutboxAccount::fetch(&mut outbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        Ok(outbox.tree)
    }

    #[instrument(err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        assert!(
            lag.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let tree = self.tree(lag).await?;

        let root = tree.root();
        let count: u32 = tree
            .count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        let index = count.checked_sub(1).ok_or_else(|| {
            ChainCommunicationError::from_contract_error_str(
                "Outbox is empty, cannot compute checkpoint",
            )
        })?;
        let checkpoint = Checkpoint {
            merkle_tree_hook_address: self.program_id.to_bytes().into(),
            mailbox_domain: self.domain().id(),
            root,
            index,
        };
        Ok(checkpoint)
    }

    #[instrument(err, ret, skip(self))]
    async fn count(&self, _maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let tree = self.tree(_maybe_lag).await?;

        tree.count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)
    }
}

/// Struct that retrieves event data for a Sealevel merkle tree hook contract
/// For now it's just a wrapper around the SealevelMailboxIndexer
#[derive(Debug, new)]
pub struct SealevelMerkleTreeHookIndexer(SealevelMailboxIndexer);

#[async_trait]
impl Indexer<MerkleTreeInsertion> for SealevelMerkleTreeHookIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let messages = Indexer::<HyperlaneMessage>::fetch_logs(&self.0, range).await?;
        let merkle_tree_insertions = messages
            .into_iter()
            .map(|(m, meta)| (message_to_merkle_tree_insertion(m.inner()).into(), meta))
            .collect();
        Ok(merkle_tree_insertions)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Indexer::<HyperlaneMessage>::get_finalized_block_number(&self.0).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for SealevelMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        SequenceAwareIndexer::<HyperlaneMessage>::latest_sequence_count_and_tip(&self.0).await
    }
}

fn message_to_merkle_tree_insertion(message: &HyperlaneMessage) -> MerkleTreeInsertion {
    let leaf_index = message.nonce;
    let message_id = message.id();
    MerkleTreeInsertion::new(leaf_index, message_id)
}
