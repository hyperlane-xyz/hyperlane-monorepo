use std::ops::RangeInclusive;

use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    HyperlaneChain, HyperlaneMessage, Indexed, Indexer, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer,
};
use hyperlane_sealevel_mailbox::accounts::OutboxAccount;
use tracing::instrument;

use crate::{SealevelMailbox, SealevelMailboxIndexer};

#[async_trait]
impl MerkleTreeHook for SealevelMailbox {
    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        assert!(
            reorg_period.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let outbox_account = self
            .get_provider()
            .rpc_client()
            .get_account_with_finalized_commitment(self.outbox.0)
            .await?;
        let outbox = OutboxAccount::fetch(&mut outbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        Ok(outbox.tree)
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        assert!(
            reorg_period.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let tree = self.tree(reorg_period).await?;

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
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let tree = self.tree(reorg_period).await?;

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
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let messages = Indexer::<HyperlaneMessage>::fetch_logs_in_range(&self.0, range).await?;
        let merkle_tree_insertions = messages
            .into_iter()
            .map(|(m, meta)| (message_to_merkle_tree_insertion(m.inner()).into(), meta))
            .collect();
        Ok(merkle_tree_insertions)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // we should not report block height since SequenceAwareIndexer uses block slot in
        // `latest_sequence_count_and_tip` and we should not report block slot here
        // since block slot cannot be used as watermark
        unimplemented!()
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
