use axum::{
    body,
    http::{header::CONTENT_TYPE, Response, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

/// result type
pub type ServerResult<T> = Result<T, ServerErrorResponse>;

/// Wrapper struct around a successful axum response
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerSuccessResponse<T: Serialize> {
    /// json body that will be sent
    pub result: T,
}

impl<T: Serialize> ServerSuccessResponse<T> {
    /// constructor
    pub fn new(result: T) -> Self {
        Self { result }
    }
}

impl<T: Serialize> IntoResponse for ServerSuccessResponse<T> {
    fn into_response(self) -> Response<body::Body> {
        let json_body = serde_json::to_string(&self.result).unwrap_or("{}".to_owned());
        let response = Response::builder()
            .header(CONTENT_TYPE, "application/json")
            .status(StatusCode::OK)
            .body(body::Body::new(json_body));
        response.expect("Failed to build response")
    }
}

/// Generic error response
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerErrorBody {
    /// message
    pub message: String,
}

/// Wrapper struct around an unsuccessful axum response
#[derive(Clone, Debug)]
pub struct ServerErrorResponse {
    /// http status code to go with the response
    pub status_code: StatusCode,
    /// json body that will be sent
    pub body: ServerErrorBody,
}

impl ServerErrorResponse {
    /// constructor
    pub fn new(status_code: StatusCode, result: ServerErrorBody) -> Self {
        Self {
            status_code,
            body: result,
        }
    }
}

impl IntoResponse for ServerErrorResponse {
    fn into_response(self) -> Response<body::Body> {
        let json_body = serde_json::to_string(&self.body).unwrap_or("{}".to_owned());
        let response = Response::builder()
            .header(CONTENT_TYPE, "application/json")
            .status(self.status_code)
            .body(body::Body::new(json_body));
        response.expect("Failed to build response")
    }
}
