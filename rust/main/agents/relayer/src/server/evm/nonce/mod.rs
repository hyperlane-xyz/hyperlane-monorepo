pub mod set_upper_nonce;

use std::{collections::HashMap, sync::Arc};

use axum::{routing::post, Router};
use derive_new::new;
use ethers::types::Address;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::HyperlaneDomainProtocol;

#[derive(Clone, Debug)]
pub struct ChainWithNonce {
    pub signer_address: Address,
    pub protocol: HyperlaneDomainProtocol,
    pub db: Arc<HyperlaneRocksDB>,
}

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub chains: HashMap<u32, ChainWithNonce>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/evm/set_upper_nonce", post(set_upper_nonce::handler))
            .with_state(self)
    }
}
