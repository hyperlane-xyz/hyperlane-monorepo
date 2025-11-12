use std::sync::Arc;

use axum::{routing::get, Router};
use derive_new::new;
use hyperlane_core::KaspaDb;
use tower_http::cors::{Any, CorsLayer};

pub mod list_deposits;
pub mod list_withdrawals;

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub kaspa_db: Arc<dyn KaspaDb>,
}

impl ServerState {
    pub fn router(self) -> Router {
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        Router::new()
            .route("/kaspa/deposit", get(list_deposits::handler))
            .route("/kaspa/withdrawal", get(list_withdrawals::handler))
            .layer(cors)
            .with_state(self)
    }
}
