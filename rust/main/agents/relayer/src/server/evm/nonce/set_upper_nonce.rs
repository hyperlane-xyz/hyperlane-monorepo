use axum::{extract::State, http::StatusCode, Json};
use lander::AdaptsChainAction;
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};

use super::ServerState;

/// Request Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
    // If provided, will set to this value.
    // If not provided, will reset upper nonce to finalized nonce.
    pub new_upper_nonce: Option<u64>,
}

/// Reset the upper nonce for an EVM chain
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<()>> {
    let RequestBody {
        domain_id,
        new_upper_nonce,
    } = payload;

    tracing::debug!(domain_id, "Fetching chain");

    let dispatcher_entrypoint = state.chains.get(&domain_id).ok_or_else(|| {
        tracing::debug!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let action = AdaptsChainAction::SetUpperNonce {
        nonce: new_upper_nonce,
    };

    dispatcher_entrypoint
        .adapter()
        .run_command(action)
        .await
        .map_err(|err| {
            tracing::debug!(domain_id, ?err, "Failed to set upper nonce");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to set upper nonce: {err}"),
                },
            )
        })?;
    Ok(ServerSuccessResponse::new(()))
}
/*
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H160};

    use crate::{server::evm::nonce::ChainWithNonce, test_utils::request::parse_body_to_json};

    use super::super::ServerState;
    use super::*;

    struct TestServerSetup {
        pub app: Router,
        pub state: ServerState,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let chains = domains
            .iter()
            .map(|domain| {
                let temp_dir = tempfile::tempdir().unwrap();
                let db = DB::from_path(temp_dir.path()).unwrap();
                let base_db = HyperlaneRocksDB::new(domain, db);
                let chain_with_nonce = ChainWithNonce {
                    signer_address: H160::random().into(),
                    protocol: domain.domain_protocol(),
                    db: Arc::new(base_db),
                };
                (domain.id(), chain_with_nonce)
            })
            .collect();
        let state = ServerState { chains };
        let app = state.clone().router();
        TestServerSetup { app, state }
    }

    async fn send_request(app: Router, body: &RequestBody) -> Response<Body> {
        let api_url = "/evm/set_upper_nonce";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    #[tokio::test]
    async fn test_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);
    }
}
 */
