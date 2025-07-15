use std::{collections::HashMap, sync::Arc};

use axum::{
    routing::{delete, get, post},
    Router,
};
use derive_new::new;
use hyperlane_core::HyperlaneDomain;
use tokio::sync::RwLock;

use crate::msg::gas_payment::GasPaymentEnforcer;

pub mod add_igp_rule;
pub mod list_igp_rules;
pub mod remove_igp_rule;

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub gas_enforcers: HashMap<HyperlaneDomain, Arc<RwLock<GasPaymentEnforcer>>>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/igp_rules", post(add_igp_rule::handler))
            .route("/igp_rules", get(list_igp_rules::handler))
            .route("/igp_rules/{index}", delete(remove_igp_rule::handler))
            .with_state(self)
    }
}
