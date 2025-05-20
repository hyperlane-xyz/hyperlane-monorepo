use axum::{
    body,
    http::{header::CONTENT_TYPE, Response, StatusCode},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerSuccessResponse<T: Serialize> {
    pub result: T,
}

impl<T: Serialize> ServerSuccessResponse<T> {
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

#[derive(Clone, Debug)]
pub struct ServerErrorResponse<T: Serialize> {
    pub status_code: StatusCode,
    pub result: T,
}

impl<T: Serialize> ServerErrorResponse<T> {
    pub fn new(status_code: StatusCode, result: T) -> Self {
        Self {
            status_code,
            result,
        }
    }
}

impl<T: Serialize> IntoResponse for ServerErrorResponse<T> {
    fn into_response(self) -> Response<body::Body> {
        let json_body = serde_json::to_string(&self.result).unwrap_or("{}".to_owned());
        let response = Response::builder()
            .header(CONTENT_TYPE, "application/json")
            .status(self.status_code)
            .body(body::Body::new(json_body));
        response.expect("Failed to build response")
    }
}

pub type ServerResult<T, E> = Result<T, ServerErrorResponse<E>>;
