use std::collections::HashMap;

use axum::extract::State;
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{ServerResult, ServerSuccessResponse};

use crate::{server::igp::ServerState, settings::GasPaymentEnforcementPolicy};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct GasEnforcementResponse {
    pub policy: GasPaymentEnforcementPolicy,
    pub matching_list: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ResponseBody {
    pub policies: HashMap<String, Vec<GasEnforcementResponse>>,
}

/// Get all interchain gas payment policies for every chain
pub async fn handler(
    State(state): State<ServerState>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let mut map = HashMap::new();
    for (domain, gas_enforcer) in state.gas_enforcers.iter() {
        let lock = gas_enforcer.read().await;
        let policies_resp: Vec<_> = lock
            .get_policies()
            .iter()
            .map(|(policy, matching_list)| GasEnforcementResponse {
                policy: policy.enforcement_type(),
                matching_list: match matching_list.0.as_ref() {
                    Some(list_elements) => list_elements
                        .iter()
                        .map(|element| format!("{:?}", element))
                        .collect(),
                    None => Vec::new(),
                },
            })
            .collect();
        map.insert(domain.name().to_string(), policies_resp);
    }
    let resp = ResponseBody { policies: map };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use axum::{
        body::{self, Body},
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, U256};

    use super::*;
    use crate::{
        msg::gas_payment::GasPaymentEnforcer,
        settings::matching_list::{Filter, ListElement},
        test_utils::request::parse_body_to_json,
    };

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let gas_enforcers: HashMap<_, _> = domains
            .iter()
            .map(|domain| {
                let temp_dir = tempfile::tempdir().unwrap();
                let db = DB::from_path(temp_dir.path()).unwrap();
                let base_db = HyperlaneRocksDB::new(domain, db);
                (
                    domain.clone(),
                    Arc::new(RwLock::new(GasPaymentEnforcer::new([], base_db))),
                )
            })
            .collect();

        let server_state = ServerState::new(gas_enforcers.clone());
        let app = server_state.router();
        TestServerSetup { app }
    }

    async fn add_rule(app: Router, body: &str) -> Response<Body> {
        let api_url = "/igp_rules";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    async fn send_request(app: Router) -> Response<Body> {
        let api_url = "/igp_rules";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .header(CONTENT_TYPE, "application/json")
            .body(body::Body::empty())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_list_igp_rules_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let body = r#"{
            "policy": {
               "Minimum": {
                    "payment": "0x64"
                }
            },
            "matching_list": [
                {
                    "origindomain": 100
                }
            ]
        }"#;
        let response = add_rule(app.clone(), body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::OK);

        let body = r#"{
            "policy": "None",
            "matching_list": [
                {
                    "destinationdomain": 100
                }
            ]
        }"#;
        let response = add_rule(app.clone(), body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::OK);

        let response = send_request(app.clone()).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);

        let expected_policies = vec![
            GasEnforcementResponse {
                policy: GasPaymentEnforcementPolicy::None,
                matching_list: vec![format!(
                    "{:?}",
                    ListElement::new(
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Enumerated(vec![100]),
                        Filter::Wildcard
                    )
                )],
            },
            GasEnforcementResponse {
                policy: GasPaymentEnforcementPolicy::Minimum {
                    payment: U256::from(100),
                },
                matching_list: vec![format!(
                    "{:?}",
                    ListElement::new(
                        Filter::Wildcard,
                        Filter::Enumerated(vec![100]),
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard
                    )
                )],
            },
        ];
        let expected = ResponseBody {
            policies: [
                (
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                    expected_policies.clone(),
                ),
                (
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                    expected_policies.clone(),
                ),
                (
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
                    expected_policies.clone(),
                ),
            ]
            .map(|(domain, policies)| (domain.name().to_string(), policies))
            .into_iter()
            .collect(),
        };

        assert_eq!(resp_body, expected);
    }
}
