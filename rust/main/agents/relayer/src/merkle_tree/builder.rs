use std::fmt::Display;

use eyre::{Context, Result};
use tracing::{debug, error, instrument};

use hyperlane_base::db::DbError;
use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, merkle::Proof},
    ChainCommunicationError, H256,
};

use crate::prover::{Prover, ProverError};

/// Struct to sync prover.
#[derive(Debug)]
pub struct MerkleTreeBuilder {
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
    pub fn new() -> Self {
        let prover = Prover::default();
        let incremental = IncrementalMerkle::default();
        Self {
            prover,
            incremental,
        }
    }

    #[instrument(err, skip(self), level="debug", fields(prover_latest_index=self.count()-1))]
    pub fn get_proof(
        &self,
        leaf_index: u32,
        root_index: u32,
    ) -> Result<Proof, MerkleTreeBuilderError> {
        self.prover
            .prove_against_previous(leaf_index as usize, root_index as usize)
            .map_err(MerkleTreeBuilderError::from)
    }

    pub fn count(&self) -> u32 {
        self.prover.count() as u32
    }

    pub fn ingest_message_id(&mut self, message_id: H256) -> Result<()> {
        const CTX: &str = "When ingesting message id";
        debug!(?message_id, "Ingesting leaf");
        self.prover.ingest(message_id).expect("tree full");
        self.incremental.ingest(message_id);
        match self.prover.root().eq(&self.incremental.root()) {
            true => Ok(()),
            false => Err(MerkleTreeBuilderError::MismatchedRoots {
                prover_root: self.prover.root(),
                incremental_root: self.incremental.root(),
            }),
        }
        .context(CTX)
    }
}
