use std::collections::HashMap;

use axum::{
    routing::{get, post},
    Router,
};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;

pub mod insert_merkle_tree_insertions;
pub mod list_merkle_tree_insertions;

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route(
                "/merkle_tree_insertions",
                get(list_merkle_tree_insertions::handler),
            )
            .route(
                "/merkle_tree_insertions",
                post(insert_merkle_tree_insertions::handler),
            )
            .with_state(self)
    }
}
