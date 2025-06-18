use std::collections::HashMap;

use axum::{
    routing::{get, post},
    Router,
};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;

pub mod insert_messages;
pub mod list_messages;

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/messages", get(list_messages::handler))
            .route("/messages", post(insert_messages::handler))
            .with_state(self)
    }
}
