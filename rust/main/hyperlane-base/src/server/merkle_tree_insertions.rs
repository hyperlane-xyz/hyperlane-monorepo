use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    server::utils::{ServerErrorBody, ServerErrorResponse},
};

use super::utils::ServerResult;

/// Query params for this endpoint
#[derive(Clone, Debug, Deserialize)]
pub struct QueryParams {
    /// domain_id
    pub domain_id: u32,
    /// leaf index to start query
    pub leaf_index_start: u32,
    /// leaf index to end query
    pub leaf_index_end: u32,
}

/// Response body for this endpoint
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    /// merkle tree insertions returned
    pub merkle_tree_insertions: Vec<TreeInsertion>,
}

/// Merkle tree insertion
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TreeInsertion {
    /// insertion block number
    pub insertion_block_number: Option<u64>,
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
    let capacity = leaf_index_end
        .saturating_add(1)
        .saturating_sub(leaf_index_start) as usize;
    let mut merkle_tree_insertions = Vec::with_capacity(capacity);
    for leaf_index in leaf_index_start..=leaf_index_end {
        let block_number_res = db
            .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&leaf_index)
            .map_err(|err| {
                let error_msg = "Failed to fetch merkle tree insertion block number";
                tracing::debug!(leaf_index, ?err, "{error_msg}");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: error_msg.to_string(),
                    },
                )
            })?;

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
                insertion_block_number: block_number_res,
                leaf_index: insertion.index(),
                message_id: format!("{:?}", insertion.message_id()),
            };
            merkle_tree_insertions.push(tree_insertion);
        }
    }
    Ok(merkle_tree_insertions)
}
