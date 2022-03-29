use crate::prover::{Prover, ProverError};
use abacus_core::{
    accumulator::{incremental::IncrementalMerkle, merkle::Proof},
    db::{AbacusDB, DbError},
    ChainCommunicationError, Checkpoint, CommittedMessage, SignedCheckpoint,
};
use color_eyre::eyre::Result;
use ethers::core::types::H256;
use std::fmt::Display;

use tracing::{debug, error, info};

/// Struct to update prover
pub struct MessageBatch {
    /// Messages
    pub messages: Vec<CommittedMessage>,
    current_checkpoint_index: u32,
    signed_target_checkpoint: SignedCheckpoint,
}

impl MessageBatch {
    pub fn new(
        messages: Vec<CommittedMessage>,
        current_checkpoint_index: u32,
        signed_target_checkpoint: SignedCheckpoint,
    ) -> Self {
        Self {
            messages,
            current_checkpoint_index,
            signed_target_checkpoint,
        }
    }
}

/// Struct to sync prover.
#[derive(Debug)]
pub struct MerkleTreeBuilder {
    db: AbacusDB,
    prover: Prover,
    incremental: IncrementalMerkle,
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

/// MerkleTreeBuilder errors
#[derive(Debug, thiserror::Error)]
pub enum MerkleTreeBuilderError {
    /// Local tree up-to-date but root does not match signed checkpoint"
    #[error("Local tree up-to-date but root does not match checkpoint. Local root: {prover_root}, incremental: {incremental_root}, checkpoint root: {checkpoint_root}. WARNING: this could indicate malicious validator and/or long reorganization process!")]
    MismatchedRoots {
        /// Root of prover's local merkle tree
        prover_root: H256,
        /// Root of the incremental merkle tree
        incremental_root: H256,
        /// New root contained in signed checkpoint
        checkpoint_root: H256,
    },
    /// Leaf index was not found in DB, despite batch providing messages after
    #[error("Leaf index was not found {leaf_index:?}")]
    UnavailableLeaf {
        /// Root of prover's local merkle tree
        leaf_index: u32,
    },
    /// Unexpected prover state
    #[error("Unexpected prover state, prover count: {prover_count:?}, message batch on chain checkpoint index: {onchain_checkpoint_index:?} and signed {signed_checkpoint_index:?}")]
    UnexpectedProverState {
        /// Count of leaves in the prover
        prover_count: u32,
        /// Batch on-chain checkpoint index
        onchain_checkpoint_index: u32,
        /// Batch signed checkpoint index
        signed_checkpoint_index: u32,
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
    pub fn new(db: AbacusDB) -> Self {
        let prover = Prover::default();
        let incremental = IncrementalMerkle::default();
        Self {
            prover,
            incremental,
            db,
        }
    }

    pub fn get_proof(&self, leaf_index: u32) -> Result<Proof, MerkleTreeBuilderError> {
        self.prover.prove(leaf_index as usize).map_err(Into::into)
    }

    fn ingest_leaf_index(&mut self, leaf_index: u32) -> Result<(), MerkleTreeBuilderError> {
        match self.db.leaf_by_leaf_index(leaf_index) {
            Ok(Some(leaf)) => {
                debug!(leaf_index = leaf_index, "Ingesting leaf");
                self.prover.ingest(leaf).expect("!tree full");
                self.incremental.ingest(leaf);
                assert_eq!(self.prover.root(), self.incremental.root());
                Ok(())
            }
            Ok(None) => {
                error!("We should not arrive here");
                Err(MerkleTreeBuilderError::UnavailableLeaf { leaf_index })
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn count(&self) -> u32 {
        self.prover.count() as u32
    }

    pub async fn update_to_checkpoint(
        &mut self,
        checkpoint: &Checkpoint,
    ) -> Result<(), MerkleTreeBuilderError> {
        if checkpoint.index == 0 {
            return Ok(());
        }
        let starting_index = self.prover.count() as u32;
        for i in starting_index..checkpoint.index {
            self.db.wait_for_leaf(i).await?;
            self.ingest_leaf_index(i)?;
        }

        let prover_root = self.prover.root();
        let incremental_root = self.incremental.root();
        let checkpoint_root = checkpoint.root;
        if prover_root != incremental_root || prover_root != checkpoint_root {
            return Err(MerkleTreeBuilderError::MismatchedRoots {
                prover_root,
                incremental_root,
                checkpoint_root,
            });
        }

        Ok(())
    }

    /// Update the prover with a message batch
    pub fn update_from_batch(
        &mut self,
        batch: &MessageBatch,
    ) -> Result<(), MerkleTreeBuilderError> {
        if self.prover.count() as u32 > batch.current_checkpoint_index {
            error!("Prover was already ahead of MessageBatch, something went wrong");
            return Err(MerkleTreeBuilderError::UnexpectedProverState {
                prover_count: self.prover.count() as u32,
                onchain_checkpoint_index: batch.current_checkpoint_index,
                signed_checkpoint_index: batch.signed_target_checkpoint.checkpoint.index,
            });
        }
        // if we are somehow behind the current index, prove until then
        for i in (self.prover.count() as u32)..batch.current_checkpoint_index + 1 {
            self.ingest_leaf_index(i)?;
        }

        debug!(
            count = self.prover.count(),
            "update_from_batch fast forward"
        );
        // prove the until target (checkpoints are 1-indexed)
        for i in
            (batch.current_checkpoint_index + 1)..batch.signed_target_checkpoint.checkpoint.index
        {
            self.ingest_leaf_index(i)?;
        }

        let prover_root = self.prover.root();
        let incremental_root = self.incremental.root();
        let checkpoint_root = batch.signed_target_checkpoint.checkpoint.root;
        if prover_root != incremental_root || prover_root != checkpoint_root {
            return Err(MerkleTreeBuilderError::MismatchedRoots {
                prover_root,
                incremental_root,
                checkpoint_root,
            });
        }

        debug!(
            count = self.prover.count(),
            "update_from_batch batch proving"
        );

        Ok(())
    }
}
