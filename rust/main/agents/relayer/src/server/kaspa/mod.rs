use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use hyperlane_base::kas_hack::DepositRecoverySender;
use hyperlane_core::KaspaDb;
use tower_http::cors::{Any, CorsLayer};

pub mod list_deposits;
pub mod list_withdrawals;
pub mod recover_deposit;

/// Server state for Kaspa endpoints
#[derive(Clone)]
pub struct ServerState {
    pub kaspa_db: Arc<dyn KaspaDb>,
    /// Optional sender for deposit recovery requests
    pub recovery_sender: Option<DepositRecoverySender>,
    /// Kaspa REST API URL for fetching transaction data
    pub rest_api_url: Option<String>,
    /// Escrow address for validating deposits
    pub escrow_address: Option<String>,
}

impl std::fmt::Debug for ServerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerState")
            .field("kaspa_db", &"<dyn KaspaDb>")
            .field("recovery_sender", &self.recovery_sender.is_some())
            .field("rest_api_url", &self.rest_api_url)
            .field("escrow_address", &self.escrow_address)
            .finish()
    }
}

impl ServerState {
    pub fn new(kaspa_db: Arc<dyn KaspaDb>) -> Self {
        Self {
            kaspa_db,
            recovery_sender: None,
            rest_api_url: None,
            escrow_address: None,
        }
    }

    pub fn with_recovery(
        mut self,
        sender: DepositRecoverySender,
        rest_api_url: String,
        escrow_address: String,
    ) -> Self {
        self.recovery_sender = Some(sender);
        self.rest_api_url = Some(rest_api_url);
        self.escrow_address = Some(escrow_address);
        self
    }

    pub fn router(self) -> Router {
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        Router::new()
            .route("/kaspa/deposit", get(list_deposits::handler))
            .route("/kaspa/withdrawal", get(list_withdrawals::handler))
            .route("/kaspa/deposit/recover", post(recover_deposit::handler))
            .layer(cors)
            .with_state(self)
    }
}
