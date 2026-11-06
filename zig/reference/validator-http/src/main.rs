//! Exact production Axum validator routes; disposable native RocksDB fixtures.
#[path = "../../../../rust/main/agents/validator/src/server/mod.rs"]
mod source;
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB, DB},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, MerkleTreeInsertion, H256};
use serde::Deserialize;
use std::{
    io::{self, BufRead},
    sync::Arc,
};
use tower::ServiceExt;
#[derive(Deserialize)]
struct Insertion {
    index: u32,
    byte: u8,
    block: Option<u64>,
}
#[derive(Deserialize)]
struct Case {
    method: String,
    path: String,
    #[serde(default)]
    observed: i64,
    #[serde(default)]
    processed: i64,
    #[serde(default)]
    actions: Vec<(String, String)>,
    #[serde(default)]
    insertions: Vec<Insertion>,
}
#[tokio::main]
async fn main() -> eyre::Result<()> {
    for line in io::stdin().lock().lines() {
        let case: Case = serde_json::from_str(&line?)?;
        let directory = tempfile::tempdir()?;
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Test1);
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(directory.path())?);
        for row in case.insertions {
            db.store_merkle_tree_insertion_by_leaf_index(
                &row.index,
                &MerkleTreeInsertion::new(row.index, H256::repeat_byte(row.byte)),
            )?;
            if let Some(block) = row.block {
                db.store_merkle_tree_insertion_block_number_by_leaf_index(&row.index, &block)?;
            }
        }
        let metrics = Arc::new(CoreMetrics::new(
            "validator",
            0,
            prometheus::Registry::new(),
        )?);
        metrics
            .latest_checkpoint()
            .with_label_values(&["validator_observed", domain.name()])
            .set(case.observed);
        metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", domain.name()])
            .set(case.processed);
        let readiness = Arc::new(source::ValidatorReadiness::default());
        for (action, operation) in case.actions {
            match action.as_str() {
                "blocked" => {
                    readiness.mark_operation_blocked(&operation);
                }
                "ready" => readiness.mark_operation_ready(&operation),
                "waiting" => readiness.mark_waiting_for_first_message(),
                _ => eyre::bail!("unknown fixture action"),
            }
        }
        let app = Router::new()
            .merge(source::router(domain, metrics, readiness))
            .merge(
                source::merkle_tree_insertions::list_merkle_tree_insertions::ServerState::new(db)
                    .router(),
            );
        let response = app
            .oneshot(
                Request::builder()
                    .method(case.method.as_str())
                    .uri(&case.path)
                    .body(Body::empty())?,
            )
            .await?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let allow = response
            .headers()
            .get("allow")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024).await?;
        let body = String::from_utf8(bytes.to_vec())?;
        let mut json = serde_json::from_str::<serde_json::Value>(&body).ok();
        if let Some(serde_json::Value::Object(value)) = &mut json {
            if value.contains_key("failure_duration_ms") {
                value.insert("failure_duration_ms".into(), serde_json::Value::Null);
            }
        }
        println!(
            "{}",
            serde_json::json!({"status":status,"content_type":content_type,"allow":allow,"body_json":json,"body_text":if json.is_some(){None}else{Some(body)}})
        );
    }
    Ok(())
}
