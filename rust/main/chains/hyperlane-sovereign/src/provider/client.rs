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

use crate::{ConnectionConf, Signer};

/// A generic rollup rest response
#[derive(Clone, Debug, Deserialize)]
struct RestResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<ErrorInfo>,
}

/// Request error details
#[derive(Clone, Deserialize)]
pub(crate) struct ErrorInfo {
    title: String,
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
        write!(f, "'{} ({}){}'", self.title, self.status, details)
    }
}

/// Either an error response from the rest server or an intermediate error.
///
/// Can be converted to [`ChainCommunicationError`] but allows for differentiating
/// between those cases and checking the status code of the response.
#[derive(Debug)]
pub(crate) enum RestClientError {
    Response(StatusCode, Vec<ErrorInfo>),
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
        let mut schema: Schema = http_get(&client, get_schema).await?;
        schema
            .chain_hash()
            .map_err(|e| custom_err!("Failed to pre-compute rollups chain hash: {e}"))?;

        Ok(SovereignClient {
            url,
            client,
            signer,
            chain_id: conf.chain_id,
            schema: Arc::new(schema),
        })
    }

    pub(crate) async fn http_get<T>(&self, query: &str) -> Result<T, RestClientError>
    where
        T: Debug + for<'a> Deserialize<'a>,
    {
        let url = self
            .url
            .join(query)
            .map_err(|e| RestClientError::Other(format!("Failed to construct url: {e}")))?;

        http_get(&self.client, url).await
    }

    pub(crate) async fn http_post<T>(&self, query: &str, json: &Value) -> Result<T, RestClientError>
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
        RestClientError::Response(status_code, errs) => {
            if status_code.is_server_error() {
                true
            } else {
                // Handle bug on rollup side where queryable slot_number
                // can lag behind `/ledger/slots/finalized`
                errs.iter()
                    .any(|err| err.title.contains("invalid rollup height"))
            }
        }
        RestClientError::Other(_) => false,
    }
}

#[instrument(skip(client), ret(level = "trace"), err(level = "info"))]
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

async fn parse_response<T>(response: Response) -> Result<T, RestClientError>
where
    T: Debug + for<'a> Deserialize<'a>,
{
    let status = response.status();
    let result: RestResponse<T> = response
        .json()
        .await
        .map_err(|e| RestClientError::Other(format!("{e:?}")))?;

    if status.is_success() {
        result
            .data
            .ok_or_else(|| RestClientError::Other("Missing data in response".into()))
    } else {
        Err(RestClientError::Response(status, result.errors))
    }
}
