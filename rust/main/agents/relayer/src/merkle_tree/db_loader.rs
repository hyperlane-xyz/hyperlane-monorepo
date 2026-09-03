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

use crate::db_loader::DbLoaderExt;

use super::builder::MerkleTreeBuilder;

const PREFIX: &str = "db_loader::merkle_tree";

/// Maximum consecutive leaves ingested under one prover write lock.
const MAX_LEAVES_PER_TICK: usize = 32;

/// Finds unprocessed merkle tree insertions and adds them to the prover sync
#[derive(new)]
pub struct MerkleTreeDbLoader {
    db: HyperlaneRocksDB,
    metrics: MerkleTreeDbLoaderMetrics,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    #[new(default)]
    leaf_index: u32,
}

impl Debug for MerkleTreeDbLoader {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MerkleTreeDbLoader {{ leaf_index: {:?} }}",
            self.leaf_index
        )
    }
}

#[async_trait]
impl DbLoaderExt for MerkleTreeDbLoader {
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
        let mut insertions = Vec::new();
        while insertions.len() < MAX_LEAVES_PER_TICK {
            let index = self.leaf_index + insertions.len() as u32;
            let begin = Instant::now();
            match self.retrieve_at(index).await? {
                Some(insertion) => {
                    self.update_metrics(&insertion, &begin);
                    insertions.push(insertion);
                }
                None => break,
            }
        }

        if insertions.is_empty() {
            trace!(leaf_index=?self.leaf_index, "No merkle tree insertion found in DB for leaf index, waiting for it to be indexed");
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(());
        }

        let begin = {
            let mut guard = self.prover_sync.write().await;
            let begin = Instant::now();
            for insertion in &insertions {
                guard.ingest_message_id(insertion.message_id())?;
                self.leaf_index += 1;
            }
            begin
        };

        self.metrics
            .merkle_tree_ingest_message_id_total_elapsed_micros
            .inc_by(begin.elapsed().as_micros() as u64);
        self.metrics
            .merkle_tree_ingest_message_ids_count
            .inc_by(insertions.len() as u64);
        Ok(())
    }
}

impl MerkleTreeDbLoader {
    async fn retrieve_at(&self, index: u32) -> Result<Option<MerkleTreeInsertion>> {
        let db = self.db.clone();
        let name = format!("{}::retrieval::{}::{}", PREFIX, self.domain(), index);
        let insertion = tokio::task::Builder::new()
            .name(&name)
            .spawn_blocking(move || db.retrieve_merkle_tree_insertion_by_leaf_index(&index))?
            .await??;
        Ok(insertion)
    }

    fn update_metrics(&self, insertion: &MerkleTreeInsertion, begin: &Instant) {
        // Update the metrics
        // we assume that leaves are inserted in order so this will be monotonically increasing
        self.metrics
            .latest_tree_insertion_index_gauge
            .set(insertion.index() as i64);
        self.metrics
            .merkle_tree_retrieve_insertion_total_elapsed_micros
            .inc_by(begin.elapsed().as_micros() as u64);
        self.metrics.merkle_tree_retrieve_insertions_count.inc();
    }
}

#[derive(Debug, Clone)]
pub struct MerkleTreeDbLoaderMetrics {
    latest_tree_insertion_index_gauge: IntGauge,
    merkle_tree_retrieve_insertion_total_elapsed_micros: IntCounter,
    merkle_tree_retrieve_insertions_count: IntCounter,
    merkle_tree_ingest_message_id_total_elapsed_micros: IntCounter,
    merkle_tree_ingest_message_ids_count: IntCounter,
}

impl MerkleTreeDbLoaderMetrics {
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

#[cfg(test)]
mod tests {
    use prometheus::Registry;

    use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB, DB};
    use hyperlane_base::CoreMetrics;
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, MerkleTreeInsertion, H256};

    use super::super::builder::MerkleTreeBuilder;
    use super::*;
    use crate::db_loader::DbLoaderExt;

    fn test_loader(insertion_count: u32, port: u16) -> (tempfile::TempDir, MerkleTreeDbLoader) {
        let dir = tempfile::tempdir().unwrap();
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(dir.path()).unwrap());
        for i in 0..insertion_count {
            db.store_merkle_tree_insertion_by_leaf_index(
                &i,
                &MerkleTreeInsertion::new(i, H256::from_low_u64_be(i as u64)),
            )
            .unwrap();
        }
        let core_metrics = CoreMetrics::new("test-merkle-loader", port, Registry::new()).unwrap();
        let loader = MerkleTreeDbLoader::new(
            db,
            MerkleTreeDbLoaderMetrics::new(&core_metrics, &domain),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
        );
        (dir, loader)
    }

    #[tokio::test]
    async fn tick_drains_backlog_in_batches_preserving_order() {
        let (_dir, mut loader) = test_loader((MAX_LEAVES_PER_TICK as u32) + 5, 49101);
        loader.tick().await.unwrap();
        assert_eq!(loader.leaf_index, MAX_LEAVES_PER_TICK as u32);
        assert_eq!(
            loader.prover_sync.read().await.count(),
            MAX_LEAVES_PER_TICK as u32
        );
        loader.tick().await.unwrap();
        assert_eq!(loader.leaf_index, (MAX_LEAVES_PER_TICK as u32) + 5);
        assert_eq!(
            loader.prover_sync.read().await.count(),
            (MAX_LEAVES_PER_TICK as u32) + 5
        );
    }

    #[tokio::test]
    async fn tick_on_gap_advances_only_past_present_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(dir.path()).unwrap());
        for i in [0u32, 1, 3] {
            db.store_merkle_tree_insertion_by_leaf_index(
                &i,
                &MerkleTreeInsertion::new(i, H256::from_low_u64_be(i as u64)),
            )
            .unwrap();
        }
        let core_metrics =
            CoreMetrics::new("test-merkle-loader-gap", 49102, Registry::new()).unwrap();
        let mut loader = MerkleTreeDbLoader::new(
            db.clone(),
            MerkleTreeDbLoaderMetrics::new(&core_metrics, &domain),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
        );
        loader.tick().await.unwrap();
        assert_eq!(loader.leaf_index, 2);
        db.store_merkle_tree_insertion_by_leaf_index(
            &2,
            &MerkleTreeInsertion::new(2, H256::from_low_u64_be(2)),
        )
        .unwrap();
        loader.tick().await.unwrap();
        assert_eq!(loader.leaf_index, 4);
        assert_eq!(loader.prover_sync.read().await.count(), 4);
        let _ = dir;
    }
}
