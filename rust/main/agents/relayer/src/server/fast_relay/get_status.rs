use axum::{extract::{Path, State}, http::StatusCode};
use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use uuid::Uuid;

use crate::fast_relay::FastRelayJob;

use super::ServerState;

/// Handler for GET /fast_relay/:id
///
/// Returns the current status of a fast relay job.
pub async fn get_fast_relay_status(
    State(state): State<ServerState>,
    Path(job_id): Path<Uuid>,
) -> ServerResult<ServerSuccessResponse<FastRelayJob>> {
    let job = state
        .job_store
        .get(&job_id)
        .await
        .ok_or_else(|| {
            ServerErrorResponse::new(
                StatusCode::NOT_FOUND,
                ServerErrorBody {
                    message: format!("Job not found: {}", job_id),
                },
            )
        })?;

    Ok(ServerSuccessResponse::new(job))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fast_relay::{JobStore, RelayStatus};
    use hyperlane_core::H256;

    #[tokio::test]
    async fn test_get_fast_relay_status() {
        let state = ServerState::new(JobStore::new());

        let job = crate::fast_relay::FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            3600,
        );
        let job_id = job.id;
        state.job_store.insert(job).await;

        let result = get_fast_relay_status(State(state.clone()), Path(job_id)).await;
        assert!(result.is_ok());

        let response = result.unwrap();
        assert_eq!(response.data.id, job_id);
        assert_eq!(response.data.status, RelayStatus::Pending);
    }

    #[tokio::test]
    async fn test_get_fast_relay_status_not_found() {
        let state = ServerState::new(JobStore::new());
        let fake_id = Uuid::new_v4();

        let result = get_fast_relay_status(State(state), Path(fake_id)).await;
        assert!(result.is_err());
    }
}
