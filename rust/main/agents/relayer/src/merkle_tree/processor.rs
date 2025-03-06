use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use prometheus::{IntCounter, IntGauge};
use tokio::sync::RwLock;
use tracing::trace;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, MerkleTreeInsertion};

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
    fn name(&self) -> String {
        format!("processor::merkle_tree::{}", self.domain().name())
    }

    /// The domain this processor is getting merkle tree hook insertions from.
    fn domain(&self) -> &HyperlaneDomain {
        self.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        if let Some(insertion) = self.next_unprocessed_leaf()? {
            // Feed the message to the prover sync

            let begin = {
                // drop the guard at the end of this block
                let mut guard = self.prover_sync.write().await;
                let begin = Instant::now();
                guard.ingest_message_id(insertion.message_id())?;
                begin
            };

            self.metrics
                .merkle_tree_ingest_message_id_total_elapsed_micros
                .inc_by(begin.elapsed().as_micros() as u64);
            self.metrics.merkle_tree_ingest_message_ids_count.inc();

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
        let begin = Instant::now();
        let leaf = if let Some(insertion) = self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&self.leaf_index)?
        {
            // Update the metrics
            // we assume that leaves are inserted in order so this will be monotonically increasing
            self.metrics
                .latest_tree_insertion_index_gauge
                .set(insertion.index() as i64);

            self.metrics
                .merkle_tree_retrieve_insertion_total_elapsed_micros
                .inc_by(begin.elapsed().as_micros() as u64);
            self.metrics.merkle_tree_retrieve_insertions_count.inc();

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
    latest_tree_insertion_index_gauge: IntGauge,
    merkle_tree_retrieve_insertion_total_elapsed_micros: IntCounter,
    merkle_tree_retrieve_insertions_count: IntCounter,
    merkle_tree_ingest_message_id_total_elapsed_micros: IntCounter,
    merkle_tree_ingest_message_ids_count: IntCounter,
}

impl MerkleTreeProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, origin: &HyperlaneDomain) -> Self {
        Self {
            latest_tree_insertion_index_gauge: metrics
                .latest_tree_insertion_index()
                .with_label_values(&[origin.name()]),
            merkle_tree_retrieve_insertion_total_elapsed_micros: metrics
                .merkle_tree_retrieve_insertion_total_elapsed_micros()
                .with_label_values(&[origin.name()]),
            merkle_tree_retrieve_insertions_count: metrics
                .merkle_tree_retrieve_insertions_count()
                .with_label_values(&[origin.name()]),
            merkle_tree_ingest_message_id_total_elapsed_micros: metrics
                .merkle_tree_ingest_message_id_total_elapsed_micros()
                .with_label_values(&[origin.name()]),
            merkle_tree_ingest_message_ids_count: metrics
                .merkle_tree_ingest_message_ids_count()
                .with_label_values(&[origin.name()]),
        }
    }
}
