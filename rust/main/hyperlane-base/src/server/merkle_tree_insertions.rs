use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    server::utils::{ServerErrorBody, ServerErrorResponse},
};

use super::utils::ServerResult;

/// Merkle tree insertion
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TreeInsertion {
    /// index of the merkle insertion
    pub leaf_index: u32,
    /// id of the message
    pub message_id: String,
}

/// fetch merkle tree insertions from rocksdb
/// inclusive
pub async fn fetch_merkle_tree_insertions(
    db: &HyperlaneRocksDB,
    leaf_index_start: u32,
    leaf_index_end: u32,
) -> ServerResult<Vec<TreeInsertion>> {
    let mut merkle_tree_insertions =
        Vec::with_capacity((leaf_index_end + 1 - leaf_index_start) as usize);
    for leaf_index in leaf_index_start..(leaf_index_end + 1) {
        let retrieve_res = db
            .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)
            .map_err(|err| {
                let error_msg = "Failed to fetch merkle tree insertion";
                tracing::debug!(leaf_index, ?err, "{error_msg}");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: error_msg.to_string(),
                    },
                )
            })?;
        if let Some(insertion) = retrieve_res {
            let tree_insertion = TreeInsertion {
                leaf_index: insertion.index(),
                message_id: format!("{:?}", insertion.message_id()),
            };
            merkle_tree_insertions.push(tree_insertion);
        }
    }
    Ok(merkle_tree_insertions)
}
