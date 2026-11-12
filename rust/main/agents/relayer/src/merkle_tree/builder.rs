use std::fmt::Display;

use eyre::{Context, Result};
use tracing::instrument;

use hyperlane_base::db::DbError;
use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, merkle::MerkleTreeError, merkle::Proof},
    ChainCommunicationError, H256,
};

use crate::prover::{Prover, ProverError};

/// Struct to sync prover.
#[derive(Debug)]
pub struct MerkleTreeBuilder {
    prover: Prover,
    incremental: IncrementalMerkle,
    // A failed independent root check must not expose proofs or retry the same
    // DB leaves against an already-mutated tree. Recovery requires a rebuild.
    root_mismatch: bool,
}

impl Display for MerkleTreeBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MerkleTreeBuilder {{ ")?;
        write!(
            f,
            "incremental: {{ root: {:?}, size: {} }}, ",
            self.incremental.root(),
            self.incremental.count()
        )?;
        write!(
            f,
            "prover: {{ root: {:?}, size: {} }} ",
            self.prover.root(),
            self.prover.count()
        )?;
        write!(f, "}}")?;
        Ok(())
    }
}

impl Default for MerkleTreeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// MerkleTreeBuilder errors
#[derive(Debug, thiserror::Error)]
pub enum MerkleTreeBuilderError {
    /// Local tree up-to-date but root does not match signed checkpoint"
    #[error("Prover root does not match incremental root: {prover_root}, incremental: {incremental_root}")]
    MismatchedRoots {
        /// Root of prover's local merkle tree
        prover_root: H256,
        /// Root of the incremental merkle tree
        incremental_root: H256,
    },
    /// MerkleTreeBuilder attempts Prover operation and receives ProverError
    #[error(transparent)]
    ProverError(#[from] ProverError),
    /// MerkleTreeBuilder receives ChainCommunicationError from chain API
    #[error(transparent)]
    ChainCommunicationError(#[from] ChainCommunicationError),
    /// DB Error
    #[error("{0}")]
    DbError(#[from] DbError),
}

impl MerkleTreeBuilder {
    /// Discard the provisional suffix while preserving the stable proof history.
    pub(crate) fn rewind(&mut self, count: u32) -> Result<()> {
        self.incremental = self.prover.truncate(count.min(self.count()) as usize);
        self.root_mismatch = self.prover.root() != self.incremental.root();
        self.ensure_verified()?;
        Ok(())
    }
    pub fn new() -> Self {
        let prover = Prover::default();
        let incremental = IncrementalMerkle::default();
        Self {
            prover,
            incremental,
            root_mismatch: false,
        }
    }

    #[instrument(err, skip(self), level="debug", fields(prover_latest_index=self.count().saturating_sub(1)))]
    pub fn get_proof(
        &self,
        leaf_index: u32,
        root_index: u32,
    ) -> Result<Proof, MerkleTreeBuilderError> {
        self.ensure_verified()?;
        self.prover
            .prove_against_previous(leaf_index as usize, root_index as usize)
            .map_err(MerkleTreeBuilderError::from)
    }

    pub fn count(&self) -> u32 {
        self.prover.count() as u32
    }

    #[cfg(test)]
    pub fn ingest_message_id(&mut self, message_id: H256) -> Result<()> {
        self.ingest_message_ids(std::slice::from_ref(&message_id))
    }

    /// Append leaves while exclusively locked, then independently verify the
    /// published root. No intermediate state may be observed by proof readers.
    pub fn ingest_message_ids(&mut self, message_ids: &[H256]) -> Result<()> {
        const CTX: &str = "When ingesting message ids";
        self.ensure_verified().context(CTX)?;
        // IncrementalMerkle uses a u32 leaf count; preflight before either tree
        // changes, including when the final batch would cross its limit.
        if message_ids.len() > (u32::MAX as usize).saturating_sub(self.incremental.count()) {
            return Err(ProverError::MerkleTreeError(
                MerkleTreeError::MerkleTreeFull,
            ))
            .context(CTX);
        }
        let prover_root = self.prover.ingest_batch(message_ids).context(CTX)?;
        for message_id in message_ids {
            tracing::trace!(?message_id, "Ingesting leaf");
            self.incremental.ingest(*message_id);
        }
        let incremental_root = self.incremental.root();
        self.root_mismatch = prover_root != incremental_root;
        self.ensure_verified().context(CTX)
    }

    fn ensure_verified(&self) -> Result<(), MerkleTreeBuilderError> {
        if self.root_mismatch {
            return Err(MerkleTreeBuilderError::MismatchedRoots {
                prover_root: self.prover.root(),
                incremental_root: self.incremental.root(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::accumulator::{merkle::MerkleTree, TREE_DEPTH};

    use super::*;

    #[test]
    fn batched_ingestion_preserves_roots_and_historical_proofs() {
        let leaves: Vec<_> = (0..513).map(H256::from_low_u64_be).collect();
        let mut builder = MerkleTreeBuilder::new();
        for batch in leaves.chunks(32) {
            builder.ingest_message_ids(batch).unwrap();
        }
        let mut reference = MerkleTree::create(&[], TREE_DEPTH);
        for (root_index, leaf) in leaves.iter().enumerate() {
            reference.push_leaf(*leaf, TREE_DEPTH).unwrap();
            for leaf_index in [0, root_index / 2, root_index] {
                let proof = builder
                    .get_proof(leaf_index as u32, root_index as u32)
                    .unwrap();
                assert_eq!(proof, reference.prove_against_current(leaf_index));
                assert_eq!(proof.root(), reference.hash());
            }
        }
        assert_eq!(builder.prover.root(), reference.hash());
        assert_eq!(builder.incremental.root(), reference.hash());
    }

    #[test]
    fn full_batch_is_rejected_before_either_tree_changes() {
        let mut builder = MerkleTreeBuilder::new();
        builder.ingest_message_id(H256::repeat_byte(0x11)).unwrap();
        // Exercise the incremental tree's stricter u32 count limit without
        // allocating billions of leaves.
        builder.incremental.count = u32::MAX as usize - 1;
        let root = builder.prover.root();
        let incremental = builder.incremental.clone();
        assert!(builder
            .ingest_message_ids(&[H256::zero(), H256::zero()])
            .is_err());
        assert_eq!(builder.prover.count(), 1);
        assert_eq!(builder.prover.root(), root);
        assert_eq!(builder.incremental, incremental);
    }

    #[test]
    fn root_mismatch_blocks_proofs_and_retries_until_rebuild() {
        let mut builder = MerkleTreeBuilder::new();
        builder.ingest_message_id(H256::repeat_byte(0x11)).unwrap();
        builder.incremental.branch[0] = H256::repeat_byte(0xff);
        assert!(builder
            .ingest_message_ids(&[H256::repeat_byte(0x22), H256::repeat_byte(0x33)])
            .is_err());
        assert!(builder.get_proof(0, 2).is_err());
        let count = builder.count();
        assert!(builder
            .ingest_message_ids(&[H256::repeat_byte(0x22), H256::repeat_byte(0x33)])
            .is_err());
        assert_eq!(builder.count(), count);
    }
}
