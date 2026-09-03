use std::{collections::HashMap, str::FromStr, sync::Arc};

use axum::{extract::State, http::StatusCode, routing, Json, Router};
use derive_new::new;
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    server::utils::{ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse},
};
use hyperlane_core::{PendingOperationStatus, ReprepareReason, H256};
use serde::{Deserialize, Serialize};

use crate::msg::{
    op_queue::OpQueue,
    pending_message::{MessageContext, PendingMessage, DEFAULT_MAX_MESSAGE_RETRIES},
};

#[derive(Clone, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
    pub op_queues: HashMap<u32, OpQueue>,
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
    pub origin_id: u32,
    pub message_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResponseBody {
    pub pending_message: String,
}

/// This endpoint will retrieve a message from the database and try
/// to process it again.
/// This endpoint is useful when the relayer believes a message has been delivered
/// but was later reorg-ed out.
///
/// curl -X POST \
///     'localhost:9090/reprocess_message' \
///     -H 'Content-type: application/json' \
/// -d '{"domain_id": 1399811149, "message_id": "0x9484bd5c635b17b28cb382249d7a6fe5ca15debfd4f824247c68d47badc5b7de"}'
///
/// Note: You may need to combine this with `POST /igp_rule` endpoint
/// to make sure interchain gas payments are not enforced.
/// ie.
/// curl -X POST \
///     -H 'Content-type: application/json' \
///     'localhost:9090/igp_rules' \
///     -d '{ "policy": "None", "matching_list": [{"messageid": "0x8ebdc20c6c728c5715412ee928599c7286151f76d9079c8bdee08a335c7d072f"}] }'
///
/// This ensures the gas payment requirement is met, because the relayer will have recorded
/// the reorg-ed gas expenditures (in db) and believes the user did not pay enough gas.
async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    tracing::debug!(?payload, "Reprocessing message");
    let RequestBody {
        origin_id: domain_id,
        message_id,
    } = payload;

    let message_id = H256::from_str(&message_id).map_err(|err| {
        let error_msg = "Failed to parse message_id";
        tracing::debug!(message_id, ?err, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ServerErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;

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
        // TODO: maybe include the app_context here in the future, for metrics
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

    // just a debug to show what was inserted into the prepare queue
    let message_str = format!("{pending_message:?}");

    prep_queue.push(Box::new(pending_message), None).await;

    let resp = ResponseBody {
        pending_message: message_str,
    };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc, time::Duration};

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use hyperlane_base::{
        cache::{LocalCache, MeteredCache, MeteredCacheConfig, OptionalCache},
        db::{HyperlaneRocksDB, DB},
    };
    use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain};
    use hyperlane_test::mocks::MockMailboxContract;
    use tokio::sync::{broadcast, Mutex};

    use super::*;
    use crate::{
        msg::db_loader::tests::dummy_cache_metrics,
        msg::op_queue::tests::dummy_metrics_and_label,
        test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder},
    };

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub dbs: HashMap<u32, HyperlaneRocksDB>,
        pub op_queues: HashMap<u32, OpQueue>,
        pub _retry_sender:
            broadcast::Sender<crate::server::operations::message_retry::MessageRetryRequest>,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let dbs: HashMap<_, _> = domains
            .iter()
            .map(|domain| {
                let temp_dir = tempfile::tempdir().unwrap();
                let db = DB::from_path(temp_dir.path()).unwrap();
                let base_db = HyperlaneRocksDB::new(domain, db);
                (domain.id(), base_db)
            })
            .collect();

        let retry_sender = broadcast::Sender::new(10);
        let op_queues: HashMap<u32, OpQueue> = domains
            .iter()
            .map(|domain| {
                let (metrics, label) = dummy_metrics_and_label();
                (
                    domain.id(),
                    OpQueue::new(
                        metrics,
                        label,
                        Arc::new(Mutex::new(retry_sender.subscribe())),
                    ),
                )
            })
            .collect();

        let cache = OptionalCache::new(Some(MeteredCache::new(
            LocalCache::new("test-cache"),
            dummy_cache_metrics(),
            MeteredCacheConfig {
                cache_name: "test-cache".to_owned(),
            },
        )));

        let mut msg_ctxs = HashMap::new();

        for origin_domain in domains.iter() {
            let db = dbs.get(&origin_domain.id()).unwrap();
            for destination_domain in domains.iter() {
                let base_metadata_builder =
                    dummy_metadata_builder(origin_domain, destination_domain, db, cache.clone());
                let mut msg_ctx =
                    dummy_message_context(Arc::new(base_metadata_builder), db, cache.clone());
                let mut mailbox = MockMailboxContract::new_with_default_ism(H256::zero());
                mailbox
                    .expect__domain()
                    .return_const(destination_domain.clone());
                msg_ctx.destination_mailbox = Arc::new(mailbox);
                msg_ctxs.insert(
                    (origin_domain.id(), destination_domain.id()),
                    Arc::new(msg_ctx),
                );
            }
        }

        let server_state = ServerState::new(dbs.clone(), op_queues.clone(), msg_ctxs);
        let app = server_state.router();

        TestServerSetup {
            app,
            dbs,
            op_queues,
            _retry_sender: retry_sender,
        }
    }

    async fn send_request(app: Router, origin_id: u32, message_id: String) -> Response<Body> {
        let api_url = "/reprocess_message";
        let body = RequestBody {
            origin_id,
            message_id,
        };
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(&body).unwrap())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    fn insert_message(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        message: &HyperlaneMessage,
        dispatched_block_number: u64,
    ) {
        dbs.get(&domain.id())
            .expect("DB not found")
            .store_message(message, dispatched_block_number)
            .expect("DB Error");
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_reprocess_message_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup {
            app,
            dbs,
            op_queues,
            _retry_sender,
        } = setup_test_server(domains);

        let message = HyperlaneMessage {
            version: 0,
            nonce: 100,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            sender: H256::from_low_u64_be(100),
            destination: KnownHyperlaneDomain::Ethereum as u32,
            recipient: H256::from_low_u64_be(200),
            body: Vec::new(),
        };

        insert_message(&dbs, &domains[0], &message, 1000);

        let message_id = format!("0x{:x}", message.id());
        let response = send_request(app, KnownHyperlaneDomain::Arbitrum as u32, message_id).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::OK);

        let op_queue_len = op_queues
            .get(&(KnownHyperlaneDomain::Ethereum as u32))
            .expect("Queue not found")
            .len()
            .await;
        assert_eq!(op_queue_len, 1);
    }

    #[tokio::test]
    async fn test_reprocess_message_wakes_empty_prepare_queue() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        ];
        let TestServerSetup {
            app,
            dbs,
            op_queues,
            _retry_sender,
        } = setup_test_server(domains);
        let message = HyperlaneMessage {
            version: 0,
            nonce: 100,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            sender: H256::from_low_u64_be(100),
            destination: KnownHyperlaneDomain::Ethereum as u32,
            recipient: H256::from_low_u64_be(200),
            body: Vec::new(),
        };
        let expected_id = message.id();
        insert_message(&dbs, &domains[0], &message, 1000);

        let mut queue = op_queues
            .get(&(KnownHyperlaneDomain::Ethereum as u32))
            .expect("Queue not found")
            .clone();
        let waiter = tokio::spawn(async move {
            loop {
                let (batch, deadline) = queue.pop_many_ready(1).await;
                if let Some(operation) = batch.into_iter().next() {
                    break operation;
                }
                queue.wait_for_ready(deadline).await;
            }
        });
        tokio::task::yield_now().await;

        let response = send_request(
            app,
            KnownHyperlaneDomain::Arbitrum as u32,
            format!("0x{expected_id:x}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let operation = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("reprocessed message should wake prepare queue")
            .expect("waiter should not panic");
        assert_eq!(operation.id(), expected_id);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_reprocess_message_not_found() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, op_queues, .. } = setup_test_server(domains);

        let message = HyperlaneMessage {
            version: 0,
            nonce: 100,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            sender: H256::from_low_u64_be(100),
            destination: KnownHyperlaneDomain::Ethereum as u32,
            recipient: H256::from_low_u64_be(200),
            body: Vec::new(),
        };

        let message_id = format!("0x{:x}", message.id());
        let response = send_request(app, KnownHyperlaneDomain::Arbitrum as u32, message_id).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::NOT_FOUND);

        let op_queue_len = op_queues
            .get(&(KnownHyperlaneDomain::Arbitrum as u32))
            .expect("Queue not found")
            .len()
            .await;
        assert_eq!(op_queue_len, 0);
    }
}
