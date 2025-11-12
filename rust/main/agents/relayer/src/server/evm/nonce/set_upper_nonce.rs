use axum::{extract::State, http::StatusCode, Json};
use hyperlane_core::{HyperlaneDomainProtocol, U256};
use lander::{NonceDb, TransactionUuid};
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};

use super::ServerState;

/// Request Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
    // If provided, will set to this value.
    // If not provided, will reset upper nonce to finalized nonce.
    pub new_upper_nonce: Option<u64>,
}

/// Response Body
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ResponseBody {
    pub old_upper_nonce: u64,
    pub new_upper_nonce: u64,
}

/// Manually insert messages into the database
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let RequestBody {
        domain_id,
        new_upper_nonce,
    } = payload;

    tracing::debug!(domain_id, "Fetching chain");
    let chain = state.chains.get(&domain_id).ok_or_else(|| {
        tracing::debug!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    if chain.protocol != HyperlaneDomainProtocol::Ethereum {
        let err = ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ServerErrorBody {
                message: format!("Domain {domain_id} is not an ethereum protocol chain"),
            },
        );
        return Err(err);
    }

    let new_upper_nonce = match new_upper_nonce {
        Some(s) => U256::from(s),
        None => chain
            .db
            .retrieve_finalized_nonce_by_signer_address(&chain.signer_address)
            .await
            .map_err(|err| {
                tracing::debug!(domain_id, ?err, "Failed to fetch finalized nonce");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: format!("Failed to fetch finalized nonce: {err}"),
                    },
                )
            })?
            .ok_or_else(|| {
                tracing::debug!(domain_id, "No finalized nonce found");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: "No finalized nonce found".to_string(),
                    },
                )
            })?,
    };

    let current_upper_nonce = chain
        .db
        .retrieve_upper_nonce_by_signer_address(&chain.signer_address)
        .await
        .map_err(|err| {
            tracing::debug!(domain_id, ?err, "Failed to fetch upper nonce");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to fetch upper nonce: {err}"),
                },
            )
        })?
        .ok_or_else(|| {
            tracing::debug!(domain_id, "No upper nonce found");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: "No upper nonce found".to_string(),
                },
            )
        })?;
    if current_upper_nonce <= new_upper_nonce {
        let err = ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ServerErrorBody {
                message: format!(
                    "New upper nonce ({}) is higher than current upper nonce ({})",
                    new_upper_nonce,
                    current_upper_nonce.as_u64(),
                ),
            },
        );
        return Err(err);
    }

    let current_finalized_nonce = chain
        .db
        .retrieve_finalized_nonce_by_signer_address(&chain.signer_address)
        .await
        .map_err(|err| {
            tracing::debug!(domain_id, ?err, "Failed to fetch finalized nonce");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to fetch finalized nonce: {err}"),
                },
            )
        })?
        .ok_or_else(|| {
            tracing::debug!(domain_id, "No finalized nonce found");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: "No finalized nonce found".to_string(),
                },
            )
        })?;
    if new_upper_nonce < current_finalized_nonce {
        let err = ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ServerErrorBody {
                message: format!(
                    "New upper nonce ({}) is lower than current finalized nonce ({})",
                    new_upper_nonce,
                    current_finalized_nonce.as_u64(),
                ),
            },
        );
        return Err(err);
    }

    tracing::debug!(
        domain_id,
        new_upper_nonce = new_upper_nonce.as_u64(),
        "Storing new upper nonce"
    );
    chain
        .db
        .store_upper_nonce_by_signer_address(&chain.signer_address, &new_upper_nonce)
        .await
        .map_err(|err| {
            tracing::debug!(domain_id, ?err, "Failed to set upper nonce");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to set upper nonce: {err}"),
                },
            )
        })?;

    // We need to clear all nonces between [new_upper_nonce, current_upper_nonce]
    let mut curr_nonce = new_upper_nonce;
    while curr_nonce <= current_upper_nonce && curr_nonce != U256::MAX {
        let tx_uuid_res = chain
            .db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(
                &curr_nonce,
                &chain.signer_address,
            )
            .await
            .map_err(|err| {
                tracing::debug!(domain_id, ?err, ?curr_nonce, "Failed to fetch tx uuid");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ServerErrorBody {
                        message: format!("Failed to fetch tx uuid: {err}"),
                    },
                )
            })?;
        let tx_uuid = match tx_uuid_res {
            Some(s) => s,
            None => {
                curr_nonce = curr_nonce.saturating_add(U256::one());
                continue;
            }
        };

        tracing::debug!(
            domain_id,
            nonce = curr_nonce.as_u64(),
            ?tx_uuid,
            "Clearing nonce and tx uuid"
        );

        if let Err(err) = chain
            .db
            .store_transaction_uuid_by_nonce_and_signer_address(
                &curr_nonce,
                &chain.signer_address,
                &TransactionUuid::default(),
            )
            .await
        {
            tracing::error!(domain_id, ?err, ?curr_nonce, "Failed to clear tx uuid");
        }
        if let Err(err) = chain
            .db
            .store_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid, &U256::MAX)
            .await
        {
            tracing::error!(domain_id, ?err, ?curr_nonce, "Failed to clear tx nonce");
        };
        curr_nonce = curr_nonce.saturating_add(U256::one());
    }

    let resp = ResponseBody {
        old_upper_nonce: current_upper_nonce.as_u64(),
        new_upper_nonce: new_upper_nonce.as_u64(),
    };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H160};

    use crate::{server::evm::nonce::ChainWithNonce, test_utils::request::parse_body_to_json};

    use super::super::ServerState;
    use super::*;

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub state: ServerState,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let chains = domains
            .iter()
            .map(|domain| {
                let temp_dir = tempfile::tempdir().unwrap();
                let db = DB::from_path(temp_dir.path()).unwrap();
                let base_db = HyperlaneRocksDB::new(domain, db);
                let chain_with_nonce = ChainWithNonce {
                    signer_address: H160::random().into(),
                    protocol: domain.domain_protocol(),
                    db: Arc::new(base_db),
                };
                (domain.id(), chain_with_nonce)
            })
            .collect();
        let state = ServerState { chains };
        let app = state.clone().router();
        TestServerSetup { app, state }
    }

    async fn send_request(app: Router, body: &RequestBody) -> Response<Body> {
        let api_url = "/evm/set_upper_nonce";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    #[tokio::test]
    async fn test_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store upper nonce");
        chain
            .db
            .store_finalized_nonce_by_signer_address(&chain.signer_address, &U256::from(90))
            .await
            .expect("Failed to store finalized nonce");

        let transactions = [
            (TransactionUuid::random(), U256::from(105)),
            (TransactionUuid::random(), U256::from(115)),
            (TransactionUuid::random(), U256::from(125)),
            (TransactionUuid::random(), U256::from(135)),
            (TransactionUuid::random(), U256::from(145)),
        ];
        for (tx_uuid, tx_nonce) in transactions.iter() {
            chain
                .db
                .store_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                    &tx_uuid,
                )
                .await
                .expect("Failed to store transaction uuid by nonce and signer address");
            chain
                .db
                .store_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid, &tx_nonce)
                .await
                .expect("Failed to store nonce by transaction uuid");
        }

        let new_upper_nonce: u64 = 100;
        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(new_upper_nonce),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let response_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        let expected_body = ResponseBody {
            old_upper_nonce: 150,
            new_upper_nonce: 100,
        };
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(response_body, expected_body);

        let db_upper_nonce = chain
            .db
            .retrieve_upper_nonce_by_signer_address(&chain.signer_address)
            .await
            .expect("Failed to retrieve upper nonce")
            .expect("No upper nonce found");
        assert_eq!(db_upper_nonce, U256::from(new_upper_nonce));
        let db_finalized_nonce = chain
            .db
            .retrieve_finalized_nonce_by_signer_address(&chain.signer_address)
            .await
            .expect("Failed to retrieve finalized nonce")
            .expect("No upper nonce found");
        assert_eq!(db_finalized_nonce, U256::from(90));

        for (tx_uuid, tx_nonce) in transactions.iter() {
            let db_tx_uuid = chain
                .db
                .retrieve_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                )
                .await
                .expect("Failed to retrieve transaction uuid by nonce and signer address")
                .expect("Transaction uuid not found");
            assert_eq!(db_tx_uuid, TransactionUuid::default());
            let db_tx_nonce = chain
                .db
                .retrieve_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid)
                .await
                .expect("Failed to retrieve nonce by transaction uuid")
                .expect("Nonce not found");
            assert_eq!(db_tx_nonce, U256::MAX);
        }
    }

    #[tokio::test]
    async fn test_higher_than_current_upper_nonce() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to retrieve finalized nonce");

        let new_upper_nonce: u64 = 150;
        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(new_upper_nonce),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_lower_than_current_finalized_nonce() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store upper nonce");
        chain
            .db
            .store_finalized_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store finalized nonce");

        let new_upper_nonce: u64 = 100;
        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(new_upper_nonce),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_set_to_finalized() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let finalized_nonce: u64 = 100;
        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store upper nonce");
        chain
            .db
            .store_finalized_nonce_by_signer_address(
                &chain.signer_address,
                &U256::from(finalized_nonce),
            )
            .await
            .expect("Failed to store finalized nonce");

        let transactions = [
            (TransactionUuid::random(), U256::from(105)),
            (TransactionUuid::random(), U256::from(115)),
            (TransactionUuid::random(), U256::from(125)),
            (TransactionUuid::random(), U256::from(135)),
            (TransactionUuid::random(), U256::from(145)),
        ];

        for (tx_uuid, tx_nonce) in transactions.iter() {
            chain
                .db
                .store_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                    &tx_uuid,
                )
                .await
                .expect("Failed to store transaction uuid by nonce and signer address");
            chain
                .db
                .store_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid, &tx_nonce)
                .await
                .expect("Failed to store nonce by transaction uuid");
        }

        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: None,
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let response_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        let expected_body = ResponseBody {
            old_upper_nonce: 150,
            new_upper_nonce: finalized_nonce,
        };
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(response_body, expected_body);

        let db_upper_nonce = chain
            .db
            .retrieve_upper_nonce_by_signer_address(&chain.signer_address)
            .await
            .expect("Failed to retrieve upper nonce")
            .expect("No upper nonce found");
        assert_eq!(db_upper_nonce, U256::from(finalized_nonce));
        let db_finalized_nonce = chain
            .db
            .retrieve_finalized_nonce_by_signer_address(&chain.signer_address)
            .await
            .expect("Failed to retrieve finalized nonce")
            .expect("No upper nonce found");
        assert_eq!(db_finalized_nonce, U256::from(finalized_nonce));

        for (tx_uuid, tx_nonce) in transactions.iter() {
            let db_tx_uuid = chain
                .db
                .retrieve_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                )
                .await
                .expect("Failed to retrieve transaction uuid by nonce and signer address")
                .expect("Transaction uuid not found");
            assert_eq!(db_tx_uuid, TransactionUuid::default());
            let db_tx_nonce = chain
                .db
                .retrieve_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid)
                .await
                .expect("Failed to retrieve nonce by transaction uuid")
                .expect("Nonce not found");
            assert_eq!(db_tx_nonce, U256::MAX);
        }
    }

    #[tokio::test]
    async fn test_domain_not_found() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let non_existent_domain_id = 99999;
        let body = RequestBody {
            domain_id: non_existent_domain_id,
            new_upper_nonce: Some(100),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_non_ethereum_protocol() {
        let domains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Neutron)];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(100),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_missing_upper_nonce_in_db() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        // Intentionally do not store upper nonce in the database
        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_finalized_nonce_by_signer_address(&chain.signer_address, &U256::from(90))
            .await
            .expect("Failed to store finalized nonce");

        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(100),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_missing_finalized_nonce_when_none_provided() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store upper nonce");
        // Intentionally do not store finalized nonce in the database

        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: None,
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_transaction_clearing_with_no_transactions() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(150))
            .await
            .expect("Failed to store upper nonce");
        chain
            .db
            .store_finalized_nonce_by_signer_address(&chain.signer_address, &U256::from(90))
            .await
            .expect("Failed to store finalized nonce");

        // No transactions in the range between new upper nonce and current upper nonce

        let new_upper_nonce: u64 = 100;
        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(new_upper_nonce),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let response_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        let expected_body = ResponseBody {
            old_upper_nonce: 150,
            new_upper_nonce: 100,
        };
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(response_body, expected_body);

        let db_upper_nonce = chain
            .db
            .retrieve_upper_nonce_by_signer_address(&chain.signer_address)
            .await
            .expect("Failed to retrieve upper nonce")
            .expect("No upper nonce found");
        assert_eq!(db_upper_nonce, U256::from(new_upper_nonce));
    }

    #[tokio::test]
    async fn test_consecutive_nonces_all_cleared() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, state } = setup_test_server(domains);

        let chain = state.chains.get(&domains[0].id()).expect("Chain not found");
        chain
            .db
            .store_upper_nonce_by_signer_address(&chain.signer_address, &U256::from(110))
            .await
            .expect("Failed to store upper nonce");
        chain
            .db
            .store_finalized_nonce_by_signer_address(&chain.signer_address, &U256::from(90))
            .await
            .expect("Failed to store finalized nonce");

        // Create transactions at every nonce from 101 to 110
        let mut transactions = Vec::new();
        for nonce in 101..=110 {
            transactions.push((TransactionUuid::random(), U256::from(nonce)));
        }

        for (tx_uuid, tx_nonce) in transactions.iter() {
            chain
                .db
                .store_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                    &tx_uuid,
                )
                .await
                .expect("Failed to store transaction uuid by nonce and signer address");
            chain
                .db
                .store_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid, &tx_nonce)
                .await
                .expect("Failed to store nonce by transaction uuid");
        }

        let new_upper_nonce: u64 = 100;
        let body = RequestBody {
            domain_id: domains[0].id(),
            new_upper_nonce: Some(new_upper_nonce),
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let response_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        let expected_body = ResponseBody {
            old_upper_nonce: 110,
            new_upper_nonce: 100,
        };
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(response_body, expected_body);

        // Verify all transactions are properly cleared
        for (tx_uuid, tx_nonce) in transactions.iter() {
            let db_tx_uuid = chain
                .db
                .retrieve_transaction_uuid_by_nonce_and_signer_address(
                    &tx_nonce,
                    &chain.signer_address,
                )
                .await
                .expect("Failed to retrieve transaction uuid by nonce and signer address")
                .expect("Transaction uuid not found");
            assert_eq!(db_tx_uuid, TransactionUuid::default());
            let db_tx_nonce = chain
                .db
                .retrieve_nonce_by_transaction_uuid(&chain.signer_address, &tx_uuid)
                .await
                .expect("Failed to retrieve nonce by transaction uuid")
                .expect("Nonce not found");
            assert_eq!(db_tx_nonce, U256::MAX);
        }
    }
}
