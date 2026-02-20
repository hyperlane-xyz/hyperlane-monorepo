use std::fmt::{self, Debug};
use std::sync::Arc;

use hyperlane_core::{ChainCommunicationError, ChainResult};
use reqwest::StatusCode;
use reqwest::{header::HeaderMap, Client, Response};
use serde::Deserialize;
use serde_json::Value;
use sov_universal_wallet::schema::Schema;
use tokio_retry::{strategy::ExponentialBackoff, Retry};
use tracing::instrument;
use url::Url;

use crate::types::{ConstantsResponse, SchemaResponse};
use crate::{ConnectionConf, Signer};

/// Request error details
#[derive(Clone, Deserialize)]
pub struct ErrorInfo {
    message: String,
    status: u64,
    details: Value,
}

impl fmt::Debug for ErrorInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> fmt::Result {
        let mut details = String::new();
        if !self.details.is_null() && !self.details.as_str().is_some_and(|s| s.is_empty()) {
            if let Ok(json) = serde_json::to_string(&self.details) {
                details = format!(": {json}");
            }
        }
        write!(f, "'{} ({}){}'", self.message, self.status, details)
    }
}

/// Either an error response from the rest server or an intermediate error.
///
/// Can be converted to [`ChainCommunicationError`] but allows for differentiating
/// between those cases and checking the status code of the response.
#[derive(Debug)]
pub enum RestClientError {
    Response(StatusCode, ErrorInfo),
    Other(String),
}

impl RestClientError {
    pub fn is_not_found(&self) -> bool {
        matches!(self, RestClientError::Response(status, _) if status == &StatusCode::NOT_FOUND)
    }
}

impl From<RestClientError> for ChainCommunicationError {
    fn from(value: RestClientError) -> Self {
        ChainCommunicationError::CustomError(format!("{value}"))
    }
}

impl fmt::Display for RestClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RestClientError::Response(status, errors) => {
                write!(f, "Received error response {status}: {errors:?}")
            }
            RestClientError::Other(err) => write!(f, "Request failed: {err}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SovereignClient {
    pub(crate) url: Url,
    pub(crate) client: Client,
    pub(crate) chain_id: u64,
    pub(crate) signer: Signer,
    /// Schema of a rollup allowing to translate between json and binary encoding
    pub(crate) schema: Arc<Schema>,
}

impl SovereignClient {
    /// Create a new Rest client for the Sovereign Hyperlane chain.
    pub async fn new(conf: &ConnectionConf, signer: Signer) -> ChainResult<Self> {
        let url = conf.url.clone();
        let client = Client::new();

        // fetch the schema and precompute the chain_hash so it can be used without mutability
        let get_schema = url
            .join("/rollup/schema")
            .map_err(|e| custom_err!("Failed to construct url: {e}"))?;
        let response: SchemaResponse = http_get(&client, get_schema).await?;
        let mut schema = response.schema;
        schema
            .chain_hash()
            .map_err(|e| custom_err!("Failed to pre-compute rollups chain hash: {e}"))?;

        let get_constants = url
            .join("/rollup/constants")
            .map_err(|e| custom_err!("Failed to construct url: {e}"))?;
        let response: ConstantsResponse = http_get(&client, get_constants).await?;
        Ok(SovereignClient {
            url,
            client,
            signer,
            chain_id: response.chain_id,
            schema: Arc::new(schema),
        })
    }

    /// Perform a GET request for the provided url.
    pub async fn http_get<T>(&self, query: &str) -> Result<T, RestClientError>
    where
        T: Debug + for<'a> Deserialize<'a>,
    {
        let url = self
            .url
            .join(query)
            .map_err(|e| RestClientError::Other(format!("Failed to construct url: {e}")))?;

        http_get(&self.client, url).await
    }

    /// Perform a POST request to the provided url using the provided JSON payload.
    pub async fn http_post<T>(&self, query: &str, json: &Value) -> Result<T, RestClientError>
    where
        T: Debug + for<'a> Deserialize<'a>,
    {
        let url = self
            .url
            .join(query)
            .map_err(|e| RestClientError::Other(format!("Failed to construct url: {e}")))?;

        http_post(&self.client, url, json).await
    }
}

fn is_retryable(err: &RestClientError) -> bool {
    match err {
        // TODO: make this more robust, handle rate limiting, etc
        RestClientError::Response(status_code, err) => {
            if status_code.is_server_error() {
                true
            } else {
                // Handle bug on rollup side where queryable slot_number
                // can lag behind `/ledger/slots/finalized`
                err.message.contains("invalid rollup height")
            }
        }
        RestClientError::Other(_) => false,
    }
}

#[instrument(skip(client), ret(level = "trace"))]
pub(crate) async fn http_get<T>(client: &Client, url: Url) -> Result<T, RestClientError>
where
    T: Debug + for<'a> Deserialize<'a>,
{
    let mut header_map = HeaderMap::default();
    header_map.insert(
        "content-type",
        "application/json".parse().expect("Well-formed &str"),
    );

    let retry_strategy = ExponentialBackoff::from_millis(10)
        .max_delay(std::time::Duration::from_millis(10000))
        .take(10);

    Retry::spawn(retry_strategy, move || {
        let url = url.clone();
        let header_map = header_map.clone();
        async move {
            let response = client
                .get(url)
                .headers(header_map)
                .send()
                .await
                .map_err(|e| RestClientError::Other(format!("{e:?}")))?;

            match parse_response(response).await {
                Err(err) if is_retryable(&err) => Err(err),
                result => Ok(result),
            }
        }
    })
    .await?
}

#[instrument(skip(client), ret(level = "debug"), err(level = "info"))]
pub(crate) async fn http_post<T>(
    client: &Client,
    url: Url,
    json: &Value,
) -> Result<T, RestClientError>
where
    T: Debug + for<'a> Deserialize<'a>,
{
    let mut header_map = HeaderMap::default();
    header_map.insert(
        "content-type",
        "application/json".parse().expect("Well-formed &str"),
    );

    let response = client
        .post(url)
        .headers(header_map)
        .json(json)
        .send()
        .await
        .map_err(|e| RestClientError::Other(format!("{e:?}")))?;

    parse_response(response).await
}

async fn try_parse_json<T>(response: Response) -> Result<T, RestClientError>
where
    T: Debug + for<'a> Deserialize<'a>,
{
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| RestClientError::Other(format!("Failed to extract body: {e:?}")))?;

    serde_json::from_str(&body).map_err(|e| {
        RestClientError::Other(format!(
            "Failed to decode JSON response with status {status}: {e:?}, body: {body}"
        ))
    })
}

async fn parse_response<T>(response: Response) -> Result<T, RestClientError>
where
    T: Debug + for<'a> Deserialize<'a>,
{
    let status = response.status();

    if status.is_success() {
        Ok(try_parse_json(response).await?)
    } else {
        let err = try_parse_json::<ErrorInfo>(response).await?;
        Err(RestClientError::Response(status, err))
    }
}
