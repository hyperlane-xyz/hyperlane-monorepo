use crate::prover::{Prover, ProverError};
use abacus_core::{
    accumulator::incremental::IncrementalMerkle,
    db::{AbacusDB, DbError},
    ChainCommunicationError, Checkpoint, CommittedMessage, SignedCheckpoint,
};
use color_eyre::eyre::Result;
use ethers::core::types::H256;
use std::fmt::Display;

use tracing::{debug, error, info, instrument};

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

    fn store_proof(&self, leaf_index: u32) -> Result<(), MerkleTreeBuilderError> {
        match self.prover.prove(leaf_index as usize) {
            Ok(proof) => {
                self.db.store_proof(leaf_index, &proof)?;
                info!(
                    leaf_index,
                    root = ?self.prover.root(),
                    "Storing proof for leaf {}",
                    leaf_index
                );
                Ok(())
            }
            // ignore the storage request if it's out of range (e.g. leaves
            // up-to-date but no update containing leaves produced yet)
            Err(ProverError::ZeroProof { index: _, count: _ }) => Ok(()),
            // bubble up any other errors
            Err(e) => Err(e.into()),
        }
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

    pub async fn update_to_checkpoint(
        &mut self,
        checkpoint: &Checkpoint,
    ) -> Result<(), MerkleTreeBuilderError> {
        if checkpoint.index == 0 {
            return Ok(());
        }
        for i in (self.prover.count() as u32)..checkpoint.index {
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
        // TODO:: If we are ahead already, something went wrong
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
        // store proofs in DB

        for message in &batch.messages {
            self.store_proof(message.leaf_index)?;
        }
        // TODO: push proofs to S3

        Ok(())
    }
}
