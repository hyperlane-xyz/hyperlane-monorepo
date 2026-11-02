//! `GET /runtime_denylist` reports the active rule counts.
//! `POST /runtime_denylist/refresh` fetches the configured URL now instead of
//! waiting for the next poll. It can't change the rules, only re-read them.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing, Json, Router};
use derive_new::new;

use crate::msg::runtime_denylist::{RuntimeDenylist, RuntimeDenylistSummary};

const RUNTIME_DENYLIST_API_BASE: &str = "/runtime_denylist";

#[derive(Clone, Debug, new)]
pub struct ServerState {
    denylist: Arc<RuntimeDenylist>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new().nest(
            RUNTIME_DENYLIST_API_BASE,
            Router::new()
                .route("/", routing::get(summary))
                .route("/refresh", routing::post(refresh))
                .with_state(self),
        )
    }
}

async fn summary(State(state): State<ServerState>) -> Json<RuntimeDenylistSummary> {
    Json(state.denylist.summary())
}

async fn refresh(
    State(state): State<ServerState>,
) -> Result<Json<RuntimeDenylistSummary>, (StatusCode, String)> {
    state.denylist.refresh().await.map(Json).map_err(|err| {
        tracing::warn!(error = ?err, "Manual runtime denylist refresh failed");
        (StatusCode::BAD_GATEWAY, format!("{err:#}"))
    })
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn refresh_without_url_returns_bad_gateway() {
        let router = ServerState::new(Arc::new(RuntimeDenylist::default())).router();
        let response = router
            .clone()
            .oneshot(
                Request::post("/runtime_denylist/refresh")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

        let response = router
            .oneshot(
                Request::get("/runtime_denylist")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }
}
