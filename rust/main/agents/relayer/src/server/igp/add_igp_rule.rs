use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{ServerResult, ServerSuccessResponse};

use crate::{
    msg::gas_payment::GasPaymentEnforcer,
    server::igp::ServerState,
    settings::{matching_list::MatchingList, GasPaymentEnforcementPolicy},
};

#[derive(Clone, Debug, Deserialize)]
pub struct RequestBody {
    pub policy: GasPaymentEnforcementPolicy,
    pub matching_list: MatchingList,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {}

/// Add a new interchain gas payment policy.
///
/// Example request
/// ```json
/// {
///     "policy": {
///         "Minimum": {
///             "payment": "0x64"
///         }
///     },
///     "matching_list": [
///         {
///             "origindomain": 100
///         }
///     ]
/// }
/// ```
pub async fn handler(
    State(mut state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let RequestBody {
        policy,
        matching_list,
    } = payload;

    tracing::debug!(?policy, ?matching_list, "Adding new IGP rule");

    for (_, gas_enforcer) in state.gas_enforcers.iter_mut() {
        let policy_impl = GasPaymentEnforcer::create_policy(&policy);
        gas_enforcer
            .write()
            .await
            .insert_new_policy(0, policy_impl, matching_list.clone());
    }
    let resp = ResponseBody {};
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain};

    use super::*;
    use crate::{
        msg::gas_payment::GasPaymentEnforcer,
        settings::matching_list::{Filter, ListElement},
    };

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub gas_enforcers: HashMap<HyperlaneDomain, Arc<RwLock<GasPaymentEnforcer>>>,
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

        TestServerSetup { app, gas_enforcers }
    }

    async fn send_request(app: Router, body: &str) -> Response<Body> {
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

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_add_igp_rule_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, gas_enforcers } = setup_test_server(domains);

        let body = r#"{
            "policy": "None",
            "matching_list": [
                {
                    "destinationdomain": 100
                }
            ]
        }"#;
        let response = send_request(app, body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::OK);

        // check db has correct merkle tree insertions
        for gas_enforcer in gas_enforcers.values() {
            let gas_enforcer_read = gas_enforcer.read().await;
            let policies = gas_enforcer_read.get_policies();
            assert_eq!(policies.len(), 1);

            let policy = &policies[0];
            assert_eq!(
                policy.0.enforcement_type(),
                GasPaymentEnforcementPolicy::None
            );
            if let Some(list_elements) = policy.1 .0.as_ref() {
                assert_eq!(
                    list_elements,
                    &vec![ListElement::new(
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Enumerated(vec![100]),
                        Filter::Wildcard,
                    )]
                );
            }
        }
    }

    #[tokio::test]
    async fn test_add_igp_rule_with_existing_rules() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, gas_enforcers } = setup_test_server(domains);

        let body = r#"{
            "policy": "None",
            "matching_list": [
                {
                    "origindomain": 100
                }
            ]
        }"#;
        let response = send_request(app.clone(), body).await;
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
        let response = send_request(app, body).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::OK);

        // check db has correct merkle tree insertions
        for gas_enforcer in gas_enforcers.values() {
            let gas_enforcer_read = gas_enforcer.read().await;
            let policies = gas_enforcer_read.get_policies();
            assert_eq!(policies.len(), 2);

            let policy = &policies[0];
            assert_eq!(
                policy.0.enforcement_type(),
                GasPaymentEnforcementPolicy::None
            );
            if let Some(list_elements) = policy.1 .0.as_ref() {
                assert_eq!(
                    list_elements,
                    &vec![ListElement::new(
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Enumerated(vec![100]),
                        Filter::Wildcard,
                    )]
                );
            }

            let policy = &policies[1];
            assert_eq!(
                policy.0.enforcement_type(),
                GasPaymentEnforcementPolicy::None
            );
            if let Some(list_elements) = policy.1 .0.as_ref() {
                assert_eq!(
                    list_elements,
                    &vec![ListElement::new(
                        Filter::Wildcard,
                        Filter::Enumerated(vec![100]),
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                    )]
                );
            }
        }
    }
}
