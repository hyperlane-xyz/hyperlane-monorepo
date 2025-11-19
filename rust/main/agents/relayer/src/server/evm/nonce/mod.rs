pub mod set_upper_nonce;

use std::collections::HashMap;

use axum::{routing::post, Router};
use derive_new::new;
use lander::DispatcherEntrypoint;

#[derive(Clone, new)]
pub struct ServerState {
    pub entrypoints: HashMap<u32, DispatcherEntrypoint>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/evm/set_upper_nonce", post(set_upper_nonce::handler))
            .with_state(self)
    }
}
