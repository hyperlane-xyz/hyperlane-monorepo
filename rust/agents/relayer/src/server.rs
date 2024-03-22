use axum::{
    extract::{Path, State},
    routing, Router,
};
use derive_new::new;
use hyperlane_core::H256;
use reqwest::StatusCode;
use std::str::FromStr;
use tokio::sync::broadcast::Sender;

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";
pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 1_000;

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn routes(tx: Sender<H256>) -> Vec<(&'static str, Router)> {
    let message_retry_api = MessageRetryApi::new(tx);

    vec![message_retry_api.get_route()]
}

#[derive(new, Clone)]
pub struct MessageRetryApi {
    tx: Sender<H256>,
}

async fn retry_message(
    State(tx): State<Sender<H256>>,
    Path(message_id): Path<String>,
) -> Result<(), StatusCode> {
    let message_id = H256::from_str(&message_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = tx
        .send(message_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/:message_id", routing::get(retry_message))
            .with_state(self.tx.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (MESSAGE_RETRY_API_BASE, self.router())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use ethers::utils::hex::ToHex;
    use hyperlane_core::{MpmcChannel, MpmcReceiver};
    use std::net::SocketAddr;

    fn setup_test_server() -> (SocketAddr, MpmcReceiver<H256>) {
        let mpmc_channel = MpmcChannel::<H256>::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
        let message_retry_api = MessageRetryApi::new(mpmc_channel.sender());
        let (path, retry_router) = message_retry_api.get_route();
        let app = Router::new().nest(path, retry_router);

        // Running the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        (addr, mpmc_channel.receiver())
    }

    #[tokio::test]
    async fn test_message_retry_api() {
        let (addr, mut rx) = setup_test_server();

        // Create a random message ID
        let message_id = H256::random();

        // Send a GET request to the server
        let response = reqwest::get(format!(
            "http://{}{}/{}",
            addr,
            MESSAGE_RETRY_API_BASE,
            message_id.encode_hex::<String>()
        ))
        .await
        .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(rx.receiver.try_recv().unwrap(), message_id);
    }
}
