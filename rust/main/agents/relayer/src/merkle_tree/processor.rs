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

const PREFIX: &str = "processor::merkle_tree";

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
        format!("{}::{}", PREFIX, self.domain().name())
    }

    /// The domain this processor is getting merkle tree hook insertions from.
    fn domain(&self) -> &HyperlaneDomain {
        self.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        if let Some(insertion) = self.next_unprocessed_leaf_task().await? {
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
    async fn next_unprocessed_leaf_task(&mut self) -> Result<Option<MerkleTreeInsertion>> {
        let index = self.leaf_index;
        let db = self.db.clone();
        let metrics = self.metrics.clone();
        let name = format!("{}::retrieval::{}::{}", PREFIX, self.domain(), index);
        let insertion = tokio::task::Builder::new()
            .name(&name)
            .spawn_blocking(move || Self::next_unprocessed_leaf(&index, &db, &metrics))?
            .await??;
        Ok(insertion)
    }

    fn next_unprocessed_leaf(
        leaf_index: &u32,
        db: &HyperlaneRocksDB,
        metrics: &MerkleTreeProcessorMetrics,
    ) -> Result<Option<MerkleTreeInsertion>> {
        let begin = Instant::now();
        let insertion = db.retrieve_merkle_tree_insertion_by_leaf_index(leaf_index)?;
        let leaf = if let Some(insertion) = insertion {
            Self::update_metrics(metrics, &insertion, &begin);
            Some(insertion)
        } else {
            trace!(
                ?leaf_index,
                "No merkle tree insertion found in DB for leaf index, waiting for it to be indexed"
            );
            None
        };

        Ok(leaf)
    }

    fn update_metrics(
        metrics: &MerkleTreeProcessorMetrics,
        insertion: &MerkleTreeInsertion,
        begin: &Instant,
    ) {
        // Update the metrics
        // we assume that leaves are inserted in order so this will be monotonically increasing
        metrics
            .latest_tree_insertion_index_gauge
            .set(insertion.index() as i64);
        metrics
            .merkle_tree_retrieve_insertion_total_elapsed_micros
            .inc_by(begin.elapsed().as_micros() as u64);
        metrics.merkle_tree_retrieve_insertions_count.inc();
    }
}

#[derive(Debug, Clone)]
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
