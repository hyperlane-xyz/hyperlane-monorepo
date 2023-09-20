use std::fmt::Display;

use eyre::Result;
use tracing::{debug, error, instrument};

use hyperlane_base::db::{DbError, HyperlaneRocksDB};
use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, merkle::Proof},
    ChainCommunicationError, H256,
};

use crate::prover::{Prover, ProverError};

/// Struct to sync prover.
#[derive(Debug)]
pub struct MerkleTreeBuilder {
    db: HyperlaneRocksDB,
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
    #[error("Prover root does not match incremental root: {prover_root}, incremental: {incremental_root}")]
    MismatchedRoots {
        /// Root of prover's local merkle tree
        prover_root: H256,
        /// Root of the incremental merkle tree
        incremental_root: H256,
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
    /// Some other error occured.
    #[error("Failed to build the merkle tree: {0}")]
    Other(String),
}

impl MerkleTreeBuilder {
    pub fn new(db: HyperlaneRocksDB) -> Self {
        let prover = Prover::default();
        let incremental = IncrementalMerkle::default();
        Self {
            prover,
            incremental,
            db,
        }
    }

    #[instrument(err, skip(self), level="debug", fields(prover_latest_index=self.count()-1))]
    pub fn get_proof(
        &self,
        message_nonce: u32,
        root_index: u32,
    ) -> Result<Option<Proof>, MerkleTreeBuilderError> {
        let Some(message_id) = self
            .db
            .retrieve_message_id_by_nonce(&message_nonce)?
        else {
            return Ok(None);
        };
        let Some(leaf_index) = self
            .db
            .retrieve_merkle_leaf_index_by_message_id(&message_id)?
        else {
            return Ok(None);
        };
        self.prover
            .prove_against_previous(leaf_index as usize, root_index as usize)
            .map(Option::from)
            .map_err(Into::into)
    }

    fn ingest_nonce(&mut self, nonce: u32) -> Result<(), MerkleTreeBuilderError> {
        match self.db.retrieve_message_id_by_nonce(&nonce) {
            Ok(Some(leaf)) => {
                self.ingest_message_id(leaf);
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
    pub async fn update_to_index(&mut self, leaf_index: u32) -> Result<(), MerkleTreeBuilderError> {
        if leaf_index >= self.count() {
            let starting_index = self.prover.count() as u32;
            for i in starting_index..=leaf_index {
                self.db.wait_for_message_nonce(i).await?;
                self.ingest_nonce(i)?;
            }

            let prover_root = self.prover.root();
            let incremental_root = self.incremental.root();
            if prover_root != incremental_root {
                return Err(MerkleTreeBuilderError::MismatchedRoots {
                    prover_root,
                    incremental_root,
                });
            }
        }

        Ok(())
    }

    pub async fn ingest_message_id(&mut self, message_id: H256) {
        debug!(?message_id, "Ingesting leaf");
        self.prover.ingest(message_id).expect("!tree full");
        self.incremental.ingest(message_id);
        assert_eq!(self.prover.root(), self.incremental.root());
    }
}
