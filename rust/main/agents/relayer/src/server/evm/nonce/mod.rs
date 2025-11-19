pub mod set_upper_nonce;

use std::{collections::HashMap, sync::Arc};

use axum::{routing::post, Router};
use derive_new::new;
use lander::CommandEntrypoint;

#[derive(Clone, new)]
pub struct ServerState {
    pub entrypoints: HashMap<u32, Arc<dyn CommandEntrypoint>>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/evm/set_upper_nonce", post(set_upper_nonce::handler))
            .with_state(self)
    }
}
