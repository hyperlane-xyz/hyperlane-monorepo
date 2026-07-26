pub mod inspect_reorged_transactions;
pub mod overwrite_upper_nonce;
pub mod reprocess_reorged_transactions;

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
                "/evm/overwrite_upper_nonce",
                post(overwrite_upper_nonce::handler),
            )
            .route(
                "/evm/inspect_reorged_transactions",
                post(inspect_reorged_transactions::handler),
            )
            .route(
                "/evm/reprocess_reorged_transactions",
                post(reprocess_reorged_transactions::handler),
            )
            .with_state(self)
    }
}
