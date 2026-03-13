use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};

use super::ServerState;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub finalized_transactions: u64,
}

/// Recount finalized transactions from DB and refresh lander gauge for a destination domain.
/// This also persists the recounted value in the DB.
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let domain_id = payload.domain_id;
    debug!(domain_id, "Looking up dispatcher entrypoint for recount");

    let dispatcher_entrypoint = state.entrypoints.get(&domain_id).ok_or_else(|| {
        warn!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let finalized_transactions = dispatcher_entrypoint
        .refresh_finalized_transaction_count()
        .await
        .map_err(|err| {
            warn!(domain_id, ?err, "Failed to recount finalized transactions");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to recount finalized transactions: {err}"),
                },
            )
        })?;

    Ok(ServerSuccessResponse::new(ResponseBody {
        finalized_transactions,
    }))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use async_trait::async_trait;
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use crate::test_utils::request::parse_body_to_json;

    use lander::{AdaptsChainAction, CommandEntrypoint, LanderError};

    use super::*;

    #[derive(Clone)]
    struct MockEntrypoint {
        count: u64,
    }

    #[async_trait]
    impl CommandEntrypoint for MockEntrypoint {
        async fn execute_command(&self, _action: AdaptsChainAction) -> Result<(), LanderError> {
            Ok(())
        }

        async fn refresh_finalized_transaction_count(&self) -> Result<u64, LanderError> {
            Ok(self.count)
        }
    }

    #[derive(Clone)]
    struct FailingEntrypoint;

    #[async_trait]
    impl CommandEntrypoint for FailingEntrypoint {
        async fn execute_command(&self, _action: AdaptsChainAction) -> Result<(), LanderError> {
            Ok(())
        }

        async fn refresh_finalized_transaction_count(&self) -> Result<u64, LanderError> {
            Err(LanderError::NonRetryableError("recount failed".to_string()))
        }
    }

    fn setup_app(entrypoints: HashMap<u32, Arc<dyn CommandEntrypoint>>) -> Router {
        ServerState::new(entrypoints).router()
    }

    #[tokio::test]
    async fn test_recount_finalized_transactions_success() {
        let mut entrypoints: HashMap<u32, Arc<dyn CommandEntrypoint>> = HashMap::new();
        entrypoints.insert(1000, Arc::new(MockEntrypoint { count: 42 }));
        let app = setup_app(entrypoints);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/lander/recount_finalized_transactions")
                    .method(Method::POST)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"domain_id":1000}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(body.finalized_transactions, 42);
    }

    #[tokio::test]
    async fn test_recount_finalized_transactions_domain_not_found() {
        let app = setup_app(HashMap::new());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/lander/recount_finalized_transactions")
                    .method(Method::POST)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"domain_id":1000}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_recount_finalized_transactions_refresh_fails() {
        let mut entrypoints: HashMap<u32, Arc<dyn CommandEntrypoint>> = HashMap::new();
        entrypoints.insert(1000, Arc::new(FailingEntrypoint));
        let app = setup_app(entrypoints);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/lander/recount_finalized_transactions")
                    .method(Method::POST)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"domain_id":1000}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
