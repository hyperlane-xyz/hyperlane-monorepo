use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::{HyperlaneDomain, MerkleTreeInsertion};
use prometheus::IntGauge;
use tokio::sync::RwLock;
use tracing::debug;

use crate::processor::ProcessorExt;

use super::builder::MerkleTreeBuilder;

/// Finds unprocessed merkle tree insertions and adds them to the prover sync
#[derive(new)]
pub struct MerkleTreeProcessor {
    db: HyperlaneRocksDB,
    metrics: MerkleTreeProcessorMetrics,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    #[new(default)]
    leaf_index: u32,
}

impl Debug for MerkleTreeProcessor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MerkleTreeProcessor {{ leaf_index: {:?} }}",
            self.leaf_index
        )
    }
}

#[async_trait]
impl ProcessorExt for MerkleTreeProcessor {
    /// The domain this processor is getting merkle tree hook insertions from.
    fn domain(&self) -> &HyperlaneDomain {
        self.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        if let Some(insertion) = self.next_unprocessed_leaf()? {
            // Feed the message to the prover sync
            self.prover_sync
                .write()
                .await
                .ingest_message_id(insertion.message_id())
                .await?;

            // No need to explicitly send the merkle tree to the submitter, since it's
            // behind a shared Arc.
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
}

impl MerkleTreeProcessor {
    fn next_unprocessed_leaf(&mut self) -> Result<Option<MerkleTreeInsertion>> {
        if let Some(insertion) = self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&self.leaf_index)?
        {
            // Update the metrics
            self.metrics
                .max_leaf_index_gauge
                .set(insertion.index() as i64);
            return Ok(Some(insertion));
        } else {
            debug!(leaf_index=?self.leaf_index, "No message found in DB for leaf index");
            return Ok(None);
        }
    }
}

#[derive(Debug)]
pub struct MerkleTreeProcessorMetrics {
    max_leaf_index_gauge: IntGauge,
}

impl MerkleTreeProcessorMetrics {
    pub fn new() -> Self {
        Self {
            max_leaf_index_gauge: IntGauge::new("max_leaf_index_gauge", "help string").unwrap(),
        }
    }
}
