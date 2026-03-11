use axum::{extract::State, http::StatusCode, Json};
use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use hyperlane_core::H256;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::fast_relay::FastRelayJob;

use super::ServerState;

/// Request to create a fast relay job
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFastRelayRequest {
    /// Origin chain name
    pub origin_chain: String,
    /// Transaction hash on origin chain (accepts hex string)
    pub tx_hash: String,
    /// Optional priority level (for future use)
    #[serde(default)]
    pub priority: Option<String>,
}

/// Response from creating a fast relay job
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFastRelayResponse {
    /// Job ID for polling status
    pub job_id: Uuid,
}

/// Handler for POST /fast_relay
///
/// Creates a new fast relay job from a transaction hash.
/// This bypasses the normal indexing pipeline and immediately processes the message.
pub async fn create_fast_relay(
    State(state): State<ServerState>,
    Json(req): Json<CreateFastRelayRequest>,
) -> ServerResult<ServerSuccessResponse<CreateFastRelayResponse>> {
    // Check rate limit
    if let Some(rate_limiter) = &state.rate_limiter {
        if !rate_limiter.check().await {
            return Err(ServerErrorResponse::new(
                StatusCode::TOO_MANY_REQUESTS,
                ServerErrorBody {
                    message: "Rate limit exceeded".to_string(),
                },
            ));
        }
    }

    // Parse tx hash from hex string (H256 for storage, will convert to H512 for RPC)
    let tx_hash_h256 = req.tx_hash.parse::<H256>().map_err(|_| {
        ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ServerErrorBody {
                message: "Invalid transaction hash format".to_string(),
            },
        )
    })?;

    // Phase 2: Extract message from transaction (if provider registry available)
    let (message_id, extracted_message) = if let Some(registry) = &state.provider_registry {
        // Convert H256 to H512 for RPC call
        let tx_hash_h512 =
            hyperlane_core::H512::from_slice(&[tx_hash_h256.as_bytes(), &[0u8; 32]].concat());

        // Extract Hyperlane message from transaction
        match registry.extract(&req.origin_chain, tx_hash_h512).await {
            Some(Ok(Some(extracted))) => {
                tracing::info!(
                    ?extracted.message_id,
                    origin = extracted.message.origin,
                    destination = extracted.message.destination,
                    nonce = extracted.message.nonce,
                    "Successfully extracted message from transaction"
                );
                (extracted.message_id, Some(extracted))
            }
            Some(Ok(None)) => {
                return Err(ServerErrorResponse::new(
                    StatusCode::BAD_REQUEST,
                    ServerErrorBody {
                        message: format!(
                            "No Hyperlane Dispatch event found in transaction {}",
                            req.tx_hash
                        ),
                    },
                ));
            }
            Some(Err(err)) => {
                tracing::warn!(?err, tx_hash = ?req.tx_hash, "Failed to extract message from transaction");
                return Err(ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: format!("Failed to fetch transaction: {}", err),
                    },
                ));
            }
            None => {
                return Err(ServerErrorResponse::new(
                    StatusCode::BAD_REQUEST,
                    ServerErrorBody {
                        message: format!("Unknown origin chain: {}", req.origin_chain),
                    },
                ));
            }
        }
    } else {
        // No provider registry - use placeholder (Phase 1 behavior)
        tracing::warn!("Provider registry not configured, using placeholder message ID");
        (H256::zero(), None)
    };

    let job = FastRelayJob::new(
        req.origin_chain,
        tx_hash_h256,
        message_id,
        3600, // 1 hour TTL
    );

    let job_id = state.job_store.insert(job).await;

    // Phase 3: Spawn async worker to inject message into processor
    if let (Some(worker), Some(extracted)) = (&state.worker, extracted_message) {
        tracing::debug!(?job_id, "Spawning fast relay worker for message injection");
        worker.spawn_processing_task(job_id, extracted.message);
    } else if state.worker.is_none() {
        tracing::warn!("Fast relay worker not configured, message will not be processed");
    }

    Ok(ServerSuccessResponse::new(CreateFastRelayResponse {
        job_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fast_relay::JobStore;

    #[tokio::test]
    async fn test_create_fast_relay() {
        let state = ServerState::new(JobStore::new());

        let req = CreateFastRelayRequest {
            origin_chain: "ethereum".to_string(),
            tx_hash: "0x0000000000000000000000000000000000000000000000000000000000000000"
                .to_string(),
            priority: None,
        };

        let result = create_fast_relay(State(state.clone()), Json(req)).await;
        assert!(result.is_ok());

        let response = result.unwrap();
        assert!(state.job_store.get(&response.data.job_id).await.is_some());
    }
}
