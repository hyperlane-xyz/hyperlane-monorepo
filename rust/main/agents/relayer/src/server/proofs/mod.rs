use std::{collections::HashMap, sync::Arc};

use axum::{routing::get, Router};
use derive_new::new;
use tokio::sync::RwLock;

use crate::merkle_tree::builder::MerkleTreeBuilder;

pub mod prove_merkle_leaf;

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub origin_prover_syncs: HashMap<u32, Arc<RwLock<MerkleTreeBuilder>>>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/merkle_proofs", get(prove_merkle_leaf::handler))
            .with_state(self)
    }
}
