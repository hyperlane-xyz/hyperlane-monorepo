use std::{cmp::Reverse, collections::HashMap, sync::Arc};

use axum::{extract::State, http::StatusCode, routing, Json, Router};
use derive_new::new;
use ethers::utils::hex;
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    server::utils::{ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse},
};
use hyperlane_core::{PendingOperationStatus, ReprepareReason, H256};
use serde::{Deserialize, Serialize};

use crate::msg::{
    op_queue::OperationPriorityQueue,
    pending_message::{MessageContext, PendingMessage, DEFAULT_MAX_MESSAGE_RETRIES},
};

#[derive(Clone, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
    pub op_queues: HashMap<u32, OperationPriorityQueue>,
    pub msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/reprocess_message", routing::post(handler))
            .with_state(self)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestBody {
    pub domain_id: u32,
    pub message_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResponseBody {
    pub message_id: String,
}

async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    tracing::debug!(?payload, "Reprocessing message");
    let RequestBody {
        domain_id,
        message_id,
    } = payload;

    let message_id_slice = hex::decode(&message_id).map_err(|err| {
        let error_msg = "Failed to parse message_id";
        tracing::debug!(message_id, ?err, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;
    let message_id = H256::from_slice(&message_id_slice);

    let db = state.dbs.get(&domain_id).ok_or_else(|| {
        let error_msg = "No db found for chain";
        tracing::debug!(domain_id, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;

    // fetch message from db
    let message = db
        .retrieve_message_by_id(&message_id)
        .map_err(|err| {
            let error_msg = "Failed to fetch message";
            tracing::debug!(domain_id, ?message_id, ?err, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?
        .ok_or_else(|| {
            let error_msg = "Message not found";
            tracing::debug!(domain_id, ?message_id, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::NOT_FOUND,
                ServerErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;

    let app_context = state
        .msg_ctxs
        .get(&(message.origin, message.destination))
        .ok_or_else(|| {
            let error_msg = "Message context not found";
            tracing::debug!(domain_id, ?message_id, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::NOT_FOUND,
                ServerErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;

    let destination = message.destination;
    // create a pending message to push into prep queue
    let pending_message = PendingMessage::new(
        message,
        app_context.clone(),
        PendingOperationStatus::Retry(ReprepareReason::Manual),
        None,
        DEFAULT_MAX_MESSAGE_RETRIES,
    );

    let prep_queue = state.op_queues.get(&destination).ok_or_else(|| {
        let error_msg = "Queue not found";
        tracing::debug!(destination, ?message_id, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;

    prep_queue
        .lock()
        .await
        .push(Reverse(Box::new(pending_message)));

    let resp = ResponseBody {
        message_id: "".into(),
    };
    Ok(ServerSuccessResponse::new(resp))
}
