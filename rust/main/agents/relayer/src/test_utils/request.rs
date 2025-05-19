use axum::body::Body;
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;

pub async fn parse_body_to_json<T: DeserializeOwned>(body: Body) -> T {
    let resp_body: Vec<u8> = body
        .collect()
        .await
        .expect("Failed to collect body data")
        .to_bytes()
        .into_iter()
        .collect();

    eprintln!("{:?}", String::from_utf8(resp_body.clone()));
    let resp_json: T =
        serde_json::from_slice(&resp_body).expect("Failed to deserialize response body");
    resp_json
}

pub async fn parse_body_to_string(body: Body) -> String {
    let resp_body: Vec<u8> = body
        .collect()
        .await
        .expect("Failed to collect body data")
        .to_bytes()
        .into_iter()
        .collect();

    let resp_body_string =
        String::from_utf8(resp_body).expect("Failed to parse body string to UTF-8");
    resp_body_string
}
