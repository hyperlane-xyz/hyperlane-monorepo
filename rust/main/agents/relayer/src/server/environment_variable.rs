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
        Router::new()
            .route("/", routing::get(get_environment_variable))
            .route("/", routing::post(set_environment_variable))
            .with_state(self.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (ENVIRONMENT_VARIABLE, self.router())
    }
}

#[cfg(test)]
mod tests {
    use std::env::VarError::NotPresent;
    use std::net::SocketAddr;

    use axum::http::StatusCode;
    use serde_json::{json, Value};

    use super::*;

    const NAME: &str = "TEST_ENVIRONMENT_VAR";
    const VALUE: &str = "TEST_VALUE";

    #[derive(Debug)]
    struct TestServerSetup {
        pub socket_address: SocketAddr,
    }

    fn setup_test_server() -> TestServerSetup {
        let api = EnvironmentVariableApi::new();
        let (path, router) = api.get_route();

        let app = Router::new().nest(path, router);

        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        TestServerSetup {
            socket_address: addr,
        }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_environment_variable() {
        let TestServerSetup {
            socket_address: addr,
            ..
        } = setup_test_server();

        let set = set();
        let response = request(addr, &set, true).await;
        assert_eq!(NAME, response.name);
        assert_eq!(Some(VALUE.to_string()), response.value);
        assert_eq!("set", response.message);
        assert_eq!(VALUE, env::var(NAME).unwrap());

        let get = get_or_remove();
        let response = request(addr, &get, false).await;
        assert_eq!(NAME, response.name);
        assert_eq!(Some(VALUE.to_string()), response.value);
        assert_eq!("got", response.message);
        assert_eq!(VALUE, env::var(NAME).unwrap());

        let remove = get_or_remove();
        let response = request(addr, &remove, true).await;
        assert_eq!(NAME, response.name);
        assert_eq!(None, response.value);
        assert_eq!("unset", response.message);
        assert_eq!(Err(NotPresent), env::var(NAME));

        let get = get_or_remove();
        let response = request(addr, &get, false).await;
        assert_eq!(NAME, response.name);
        assert_eq!(None, response.value);
        assert_eq!("got", response.message);
        assert_eq!(Err(NotPresent), env::var(NAME));
    }

    async fn request(addr: SocketAddr, body: &Value, post: bool) -> EnvironmentVariableResponse {
        let client = reqwest::Client::new();

        let builder = if post {
            client.post(format!("http://{}{}", addr, ENVIRONMENT_VARIABLE))
        } else {
            client.get(format!("http://{}{}", addr, ENVIRONMENT_VARIABLE))
        };

        let request = builder.json(&body).build().unwrap();
        let response = tokio::spawn(client.execute(request))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let response = response
            .json::<EnvironmentVariableResponse>()
            .await
            .unwrap();
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
