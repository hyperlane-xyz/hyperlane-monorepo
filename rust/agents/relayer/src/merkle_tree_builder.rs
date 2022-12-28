use std::fmt::Display;

use eyre::Result;
use tracing::{debug, error, instrument};

use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, merkle::Proof},
    db::{DbError, HyperlaneDB},
    ChainCommunicationError, Checkpoint, H256,
};

use crate::prover::{Prover, ProverError};

/// Struct to sync prover.
#[derive(Debug)]
pub struct MerkleTreeBuilder {
    db: HyperlaneDB,
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
    /// Nonce was not found in DB, despite batch providing messages after
    #[error("Nonce was not found {nonce:?}")]
    UnavailableNonce {
        /// Root of prover's local merkle tree
        nonce: u32,
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
    pub fn new(db: HyperlaneDB) -> Self {
        let prover = Prover::default();
        let incremental = IncrementalMerkle::default();
        Self {
            prover,
            incremental,
            db,
        }
    }

    #[instrument(err, skip(self), level = "debug")]
    pub fn get_proof(&self, nonce: u32) -> Result<Proof, MerkleTreeBuilderError> {
        self.prover.prove(nonce as usize).map_err(Into::into)
    }

    fn ingest_nonce(&mut self, nonce: u32) -> Result<(), MerkleTreeBuilderError> {
        match self.db.message_id_by_nonce(nonce) {
            Ok(Some(leaf)) => {
                debug!(nonce, "Ingesting leaf");
                self.prover.ingest(leaf).expect("!tree full");
                self.incremental.ingest(leaf);
                assert_eq!(self.prover.root(), self.incremental.root());
                Ok(())
            }
            Ok(None) => {
                error!("We should not arrive here");
                Err(MerkleTreeBuilderError::UnavailableNonce { nonce })
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn count(&self) -> u32 {
        self.prover.count() as u32
    }

    #[instrument(err, skip(self), level = "debug")]
    pub async fn update_to_checkpoint(
        &mut self,
        checkpoint: &Checkpoint,
    ) -> Result<(), MerkleTreeBuilderError> {
        if checkpoint.index == 0 {
            return Ok(());
        }
        let starting_index = self.prover.count() as u32;
        for i in starting_index..=checkpoint.index {
            self.db.wait_for_message_id(i).await?;
            self.ingest_nonce(i)?;
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
}
