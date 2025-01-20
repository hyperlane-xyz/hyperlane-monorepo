use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, MerkleTreeInsertion};
use prometheus::IntGauge;
use tokio::sync::RwLock;
use tracing::trace;

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

            // Increase the leaf index to move on to the next leaf
            self.leaf_index += 1;
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
}

impl MerkleTreeProcessor {
    fn next_unprocessed_leaf(&mut self) -> Result<Option<MerkleTreeInsertion>> {
        let leaf = if let Some(insertion) = self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&self.leaf_index)?
        {
            // Update the metrics
            // we assume that leaves are inserted in order so this will be monotonically increasing
            self.metrics
                .latest_leaf_index_gauge
                .set(insertion.index() as i64);
            Some(insertion)
        } else {
            trace!(leaf_index=?self.leaf_index, "No merkle tree insertion found in DB for leaf index, waiting for it to be indexed");
            None
        };
        Ok(leaf)
    }
}

#[derive(Debug)]
pub struct MerkleTreeProcessorMetrics {
    latest_leaf_index_gauge: IntGauge,
}

impl MerkleTreeProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, origin: &HyperlaneDomain) -> Self {
        Self {
            latest_leaf_index_gauge: metrics
                .latest_leaf_index()
                .with_label_values(&[origin.name()]),
        }
    }
}
