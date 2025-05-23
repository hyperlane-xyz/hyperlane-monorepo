use axum::http::StatusCode;
use hyperlane_core::HyperlaneMessage;

use crate::{
    db::HyperlaneRocksDB,
    server::utils::{ServerErrorBody, ServerErrorResponse},
};

use super::utils::ServerResult;

/// fetch merkle tree insertions from rocksdb
/// inclusive
pub async fn fetch_messages(
    db: &HyperlaneRocksDB,
    nonce_start: u32,
    nonce_end: u32,
) -> ServerResult<Vec<HyperlaneMessage>> {
    let mut messages = Vec::with_capacity((nonce_end + 1 - nonce_start) as usize);
    for nonce in nonce_start..(nonce_end + 1) {
        let retrieve_res = db.retrieve_message_by_nonce(nonce).map_err(|err| {
            let error_msg = "Failed to fetch message";
            tracing::debug!(nonce, ?err, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;
        if let Some(msg) = retrieve_res {
            messages.push(msg);
        }
    }
    Ok(messages)
}
