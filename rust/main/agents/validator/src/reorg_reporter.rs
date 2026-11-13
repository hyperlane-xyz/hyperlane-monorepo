use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::utils::keccak256;
use futures_util::future::join_all;
use serde::Serialize;
use tracing::{info, warn};
use url::Url;

use hyperlane_base::CheckpointSyncer;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{CheckpointAtBlock, MerkleTreeHook, ReorgPeriod, H256};
use redact::Secret;

#[async_trait]
pub trait ReorgReporter: Send + Sync + Debug {
    async fn report_at_block(&self, height: u64);
    async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod);
}

#[derive(Debug)]
pub struct LatestCheckpointReorgReporter {
    merkle_tree_hooks: HashMap<Secret<Url>, Arc<dyn MerkleTreeHook>>,
    storage_writer: Arc<dyn CheckpointSyncer>,
}

#[derive(Serialize)]
struct ReorgReportRpcResponse {
    rpc_url_hash: H256,
    rpc_host_hash: H256,
    height: Option<u64>,
    reorg_period: Option<ReorgPeriod>,
    merkle_root_index: u32,
    merkle_root_hash: H256,
    timestamp: String,
}

impl ReorgReportRpcResponse {
    fn new(
        url: Url,
        latest_checkpoint: CheckpointAtBlock,
        height: Option<u64>,
        reorg_period: Option<ReorgPeriod>,
    ) -> Self {
        ReorgReportRpcResponse {
            rpc_host_hash: H256::from_slice(&keccak256(url.host_str().unwrap_or("").as_bytes())),
            rpc_url_hash: H256::from_slice(&keccak256(url.as_str().as_bytes())),
            height,
            reorg_period,
            merkle_root_hash: latest_checkpoint.checkpoint.root,
            merkle_root_index: latest_checkpoint.checkpoint.index,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Clone)]
enum ReportTarget {
    Block(u64),
    Finality(ReorgPeriod),
}

#[async_trait]
impl ReorgReporter for LatestCheckpointReorgReporter {
    async fn report_at_block(&self, height: u64) {
        self.report(ReportTarget::Block(height)).await;
    }

    async fn report_with_reorg_period(&self, period: &ReorgPeriod) {
        self.report(ReportTarget::Finality(period.clone())).await;
    }
}

impl LatestCheckpointReorgReporter {
    pub(crate) fn new(
        hooks: impl IntoIterator<Item = (Url, Arc<dyn MerkleTreeHook>)>,
        storage_writer: Arc<dyn CheckpointSyncer>,
    ) -> Self {
        Self {
            merkle_tree_hooks: hooks
                .into_iter()
                .map(|(url, hook)| (Secret::new(url), hook))
                .collect(),
            storage_writer,
        }
    }

    async fn report(&self, target: ReportTarget) {
        let (height, period) = match &target {
            ReportTarget::Block(height) => (Some(*height), None),
            ReportTarget::Finality(period) => (None, Some(period.clone())),
        };
        info!(?height, ?period, "Reporting latest checkpoint on reorg");
        let reports = join_all(self.merkle_tree_hooks.iter().map(|(url, hook)| async {
            let checkpoint = call_and_retry_indefinitely(|| {
                let hook = hook.clone();
                let target = target.clone();
                Box::pin(async move {
                    match target {
                        ReportTarget::Block(height) => {
                            hook.latest_checkpoint_at_block(height).await
                        }
                        ReportTarget::Finality(period) => hook.latest_checkpoint(&period).await,
                    }
                })
            })
            .await;
            let url = url.expose_secret();
            info!(rpc_url_hash = ?H256::from_slice(&keccak256(url.as_str().as_bytes())),
                ?height, ?period, ?checkpoint, "Report latest checkpoint on reorg");
            ReorgReportRpcResponse::new(url.clone(), checkpoint, height, period.clone())
        }))
        .await;
        self.submit_to_storage_writer(&reports).await;
    }

    async fn submit_to_storage_writer(&self, storage_logs_entries: &[ReorgReportRpcResponse]) {
        let json_string = serde_json::to_string_pretty(storage_logs_entries).unwrap_or_else(|e| {
            warn!("Error serializing json: {}", e);
            String::from("{\"error\": \"Error formatting the string\"}")
        });
        self.storage_writer
            .write_reorg_rpc_responses(json_string)
            .await
            .unwrap_or_else(|e| {
                warn!("Error writing checkpoint syncer to reorg log: {}", e);
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::mock_merkle_tree_hook::MockMerkleTreeHook;

    #[test]
    fn reporter_debug_omits_rpc_credentials() {
        let url =
            Url::parse("https://user:private-password@localhost/private-path?key=private-query")
                .unwrap();
        let mut hook = MockMerkleTreeHook::new();
        hook.expect_fmt()
            .returning(|formatter| formatter.write_str("MockMerkleTreeHook"));
        let hook: Arc<dyn MerkleTreeHook> = Arc::new(hook);
        let storage = hyperlane_base::tests::mock_checkpoint_syncer::MockCheckpointSyncer::new();
        let reporter = LatestCheckpointReorgReporter::new([(url, hook)], Arc::new(storage));
        let output = format!("{reporter:?}");
        assert!(!output.contains("private-"));
        assert!(output.contains("merkle_tree_hooks"));
        assert!(output.contains("MockMerkleTreeHook"));
        assert!(output.contains("[REDACTED"));
    }
    #[tokio::test]
    async fn shared_hook_reports_are_persisted_without_endpoint_credentials() {
        use hyperlane_base::LocalStorage;
        use hyperlane_core::Checkpoint;
        use mockall::predicate::eq;

        for at_block in [true, false] {
            let directory = tempfile::tempdir().expect("report directory");
            let storage =
                LocalStorage::new(directory.path().to_owned(), None).expect("report storage");
            let checkpoint = CheckpointAtBlock {
                checkpoint: Checkpoint {
                    mailbox_domain: 1,
                    merkle_tree_hook_address: H256::from_low_u64_be(2),
                    root: H256::repeat_byte(3),
                    index: 7,
                },
                block_height: Some(12),
            };
            let mut hook = MockMerkleTreeHook::new();
            if at_block {
                hook.expect_latest_checkpoint_at_block()
                    .with(eq(12))
                    .once()
                    .return_once(move |_| Ok(checkpoint));
            } else {
                hook.expect_latest_checkpoint()
                    .with(eq(ReorgPeriod::None))
                    .once()
                    .return_once(move |_| Ok(checkpoint));
            }
            let hook: Arc<dyn MerkleTreeHook> = Arc::new(hook);
            let url = Url::parse(
                "https://user:private-password@localhost/private-path?key=private-query",
            )
            .expect("endpoint");
            let reporter =
                LatestCheckpointReorgReporter::new([(url, hook.clone())], Arc::new(storage));
            assert!(Arc::ptr_eq(
                reporter
                    .merkle_tree_hooks
                    .values()
                    .next()
                    .expect("shared hook"),
                &hook
            ));
            if at_block {
                ReorgReporter::report_at_block(&reporter, 12).await;
            } else {
                ReorgReporter::report_with_reorg_period(&reporter, &ReorgPeriod::None).await;
            }
            let json = tokio::fs::read_to_string(directory.path().join("reorg_rpc_responses.json"))
                .await
                .expect("persisted report");
            assert!(!json.contains("private-"));
            let rows: serde_json::Value = serde_json::from_str(&json).expect("report JSON");
            assert_eq!(rows[0]["merkle_root_index"], 7);
            assert_eq!(
                rows[0]["height"],
                if at_block {
                    serde_json::json!(12)
                } else {
                    serde_json::Value::Null
                }
            );
        }
    }
}
