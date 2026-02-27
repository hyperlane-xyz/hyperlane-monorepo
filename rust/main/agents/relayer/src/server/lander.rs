pub mod recount_finalized_transactions;

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
            .route(
                "/lander/recount_finalized_transactions",
                post(recount_finalized_transactions::handler),
            )
            .with_state(self)
    }
}
