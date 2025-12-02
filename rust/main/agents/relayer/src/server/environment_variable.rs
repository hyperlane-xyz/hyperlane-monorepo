use std::env;

use axum::{extract::State, routing, Json, Router};
use derive_new::new;
use serde::{Deserialize, Serialize};

const ENVIRONMENT_VARIABLE: &str = "/environment_variable";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct SetEnvironmentVariableRequest {
    name: String,
    value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct EnvironmentVariableResponse {
    name: String,
    value: Option<String>,
    message: String,
}

#[derive(new, Clone)]
pub struct EnvironmentVariableApi {}

async fn get_environment_variable(
    State(_): State<EnvironmentVariableApi>,
    Json(body): Json<SetEnvironmentVariableRequest>,
) -> Result<Json<EnvironmentVariableResponse>, String> {
    let value = env::var(&body.name).ok();

    let response = EnvironmentVariableResponse {
        name: body.name,
        value,
        message: "got".to_string(),
    };

    Ok(Json(response))
}

async fn set_environment_variable(
    State(_): State<EnvironmentVariableApi>,
    Json(body): Json<SetEnvironmentVariableRequest>,
) -> Result<Json<EnvironmentVariableResponse>, String> {
    let message = match &body.value {
        None => {
            env::remove_var(&body.name);
            "unset"
        }
        Some(value) => {
            env::set_var(&body.name, value);
            "set"
        }
    };

    let response = EnvironmentVariableResponse {
        name: body.name,
        value: body.value,
        message: message.to_string(),
    };

    Ok(Json(response))
}

impl EnvironmentVariableApi {
    pub fn router(&self) -> Router {
        Router::new().nest(
            ENVIRONMENT_VARIABLE,
            Router::new()
                .route("/", routing::get(get_environment_variable))
                .route("/", routing::post(set_environment_variable))
                .with_state(self.clone()),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::env::VarError::NotPresent;

    use axum::http::{header::CONTENT_TYPE, Method, Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::test_utils::request::parse_body_to_json;

    use super::*;

    const NAME: &str = "TEST_ENVIRONMENT_VAR";
    const VALUE: &str = "TEST_VALUE";

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
    }

    fn setup_test_server() -> TestServerSetup {
        let api = EnvironmentVariableApi::new();
        let app = api.router();

        TestServerSetup { app }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_environment_variable() {
        let TestServerSetup { app } = setup_test_server();

        let set = set();
        let response = request(&app, &set, Method::POST).await;
        assert_eq!(NAME, response.name);
        assert_eq!(Some(VALUE.to_string()), response.value);
        assert_eq!("set", response.message);
        assert_eq!(VALUE, env::var(NAME).unwrap());

        let get = get_or_remove();
        let response = request(&app, &get, Method::GET).await;
        assert_eq!(NAME, response.name);
        assert_eq!(Some(VALUE.to_string()), response.value);
        assert_eq!("got", response.message);
        assert_eq!(VALUE, env::var(NAME).unwrap());

        let remove = get_or_remove();
        let response = request(&app, &remove, Method::POST).await;
        assert_eq!(NAME, response.name);
        assert_eq!(None, response.value);
        assert_eq!("unset", response.message);
        assert_eq!(Err(NotPresent), env::var(NAME));

        let get = get_or_remove();
        let response = request(&app, &get, Method::GET).await;
        assert_eq!(NAME, response.name);
        assert_eq!(None, response.value);
        assert_eq!("got", response.message);
        assert_eq!(Err(NotPresent), env::var(NAME));
    }

    async fn request(app: &Router, body: &Value, method: Method) -> EnvironmentVariableResponse {
        let api_url = ENVIRONMENT_VARIABLE;
        let request = Request::builder()
            .uri(api_url)
            .method(method)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");

        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");

        assert_eq!(response.status(), StatusCode::OK);

        let response: EnvironmentVariableResponse = parse_body_to_json(response.into_body()).await;
        response
    }

    fn set() -> Value {
        json!(
            {
                "name": NAME,
                "value": VALUE,
            }
        )
    }

    fn get_or_remove() -> Value {
        json!(
            {
                "name": NAME,
            }
        )
    }
}
