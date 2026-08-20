use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::Client as ReqwestClient;
use reqwest_utils::parse_custom_rpc_headers;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;
use url::Url;

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::provider::{HttpClient, HttpClientBuilder};
use crate::HyperlaneAleoError;

// Default timeouts
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

fn append_path(base_url: &Url, path: &str) -> ChainResult<Url> {
    let mut url = base_url.clone();
    url.path_segments_mut()
        .map_err(|_| HyperlaneAleoError::Other(format!("Invalid base URL: {base_url}")))?
        .pop_if_empty()
        .extend(path.split('/'));

    // `Url` leaves square brackets unescaped in path segments, but Aleo RPC
    // gateways reject bracketed plaintext mapping keys unless they are encoded.
    let encoded_path = url.path().replace('[', "%5B").replace(']', "%5D");
    url.set_path(&encoded_path);
    Ok(url)
}

fn append_network(base_url: Url, network: u16) -> ChainResult<Url> {
    let network = match network {
        0 => "mainnet",
        1 => "testnet",
        2 => "canary",
        id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
    };
    append_path(&base_url, network)
}

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug)]
pub struct BaseHttpClient {
    client: ReqwestClient,
    base_url: Url,
}

impl BaseHttpClient {
    pub fn new(base_url: Url, network: u16) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let client = ReqwestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client,
            base_url: append_network(url, network)?,
        })
    }
}

#[async_trait]
impl HttpClient for BaseHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let url = append_path(&self.base_url, path)?;
        let query: serde_json::Value = query.into().unwrap_or_default();
        let response = self
            .client
            .get(url)
            .query(&query)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        let json = response.json().await.map_err(HyperlaneAleoError::from)?;
        Ok(json)
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let url = append_path(&self.base_url, path)?;
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        Ok(response.json().await.map_err(HyperlaneAleoError::from)?)
    }
}

impl HttpClientBuilder for BaseHttpClient {
    type Client = BaseHttpClient;

    fn build(url: Url, network: u16) -> ChainResult<Self::Client> {
        BaseHttpClient::new(url, network)
    }
}

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug)]
pub struct JWTBaseHttpClient {
    client: ReqwestClient,
    base_url: Url,
    auth_url: String,
    auth_token: Arc<RwLock<Option<(HeaderValue, Instant)>>>,
}

impl JWTBaseHttpClient {
    /// Creates a new Http client
    pub fn new(base_url: Url, network: u16) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let auth_url = headers
            .get("x-auth-url")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let client = ReqwestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .cookie_store(true)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client,
            base_url: append_network(url, network)?,
            auth_token: Default::default(),
            auth_url,
        })
    }

    /// Gets the authentication token if it is still valid
    pub async fn get_auth_token(&self) -> ChainResult<HeaderValue> {
        {
            let auth_token = self.auth_token.read().await;
            if let Some((token, expires_at)) = &*auth_token {
                if Instant::now() < *expires_at {
                    return Ok(token.clone());
                }
            }
        }

        let response = self
            .client
            .post(&self.auth_url)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;
        let result = response
            .headers()
            .get(AUTHORIZATION)
            .ok_or(HyperlaneAleoError::MissingAuthHeader)?
            .clone();
        let expires = Instant::now()
            .checked_add(Duration::from_secs(60 * 15))
            .unwrap_or(Instant::now()); // Tokens last 15 minutes
        let mut auth_token = self.auth_token.write().await;
        *auth_token = Some((result.clone(), expires));
        Ok(result.clone())
    }

    async fn clear_auth_token(&self) {
        let mut auth_token = self.auth_token.write().await;
        *auth_token = None;
    }
}

#[async_trait]
impl HttpClient for JWTBaseHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let url = append_path(&self.base_url, path)?;
        let query: serde_json::Value = query.into().unwrap_or_default();
        let auth = self.get_auth_token().await?;
        let response = self
            .client
            .get(url)
            .header(AUTHORIZATION, auth)
            .query(&query)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;

        // Two instances of the relayer might compete for the same JWT, if so clear the token early and request a new one
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.clear_auth_token().await;
        }

        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;

        let json = response.json().await.map_err(HyperlaneAleoError::from)?;
        Ok(json)
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let url = append_path(&self.base_url, path)?;
        let auth = self.get_auth_token().await?;
        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, auth)
            .json(body)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;

        // Two instances of the relayer might compete for the same JWT, if so clear the token early and request a new one
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.clear_auth_token().await;
        }

        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        Ok(response.json().await.map_err(HyperlaneAleoError::from)?)
    }
}

impl HttpClientBuilder for JWTBaseHttpClient {
    type Client = JWTBaseHttpClient;

    fn build(url: Url, network: u16) -> ChainResult<Self::Client> {
        JWTBaseHttpClient::new(url, network)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    use serde_json::{json, Value};
    use url::Url;

    use super::{append_network, append_path, BaseHttpClient, HttpClient};

    #[test]
    fn appends_and_encodes_path_segments() {
        let base_url = append_network(
            Url::parse("https://api.explorer.provable.com/v2/").unwrap(),
            0,
        )
        .unwrap();
        let url = append_path(
            &base_url,
            "program/hyp_validator_announce.aleo/mapping/storage_sequences/{ bytes: [79u8, 151u8] }",
        )
        .unwrap();

        assert_eq!(
            url.as_str(),
            "https://api.explorer.provable.com/v2/mainnet/program/hyp_validator_announce.aleo/mapping/storage_sequences/%7B%20bytes:%20%5B79u8,%20151u8%5D%20%7D"
        );
    }

    #[test]
    fn appends_path_to_ipv6_base_url() {
        let base_url = Url::parse("http://[::1]:3030/v2").unwrap();
        let url = append_path(&base_url, "mapping/{ bytes: [79u8] }").unwrap();

        assert_eq!(
            url.as_str(),
            "http://[::1]:3030/v2/mapping/%7B%20bytes:%20%5B79u8%5D%20%7D"
        );
    }

    #[tokio::test]
    async fn standard_client_post_encodes_bracketed_mapping_keys() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let length = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..length]);
            request_tx
                .send(request.lines().next().unwrap().to_owned())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .unwrap();
        });
        let client =
            BaseHttpClient::new(Url::parse(&format!("http://{address}/v2")).unwrap(), 0).unwrap();

        let response: Value = client
            .request_post("mapping/{bytes:[1u8]}", &json!({}))
            .await
            .unwrap();

        assert_eq!(response, json!({ "ok": true }));
        assert_eq!(
            request_rx.recv().unwrap(),
            "POST /v2/mainnet/mapping/%7Bbytes:%5B1u8%5D%7D HTTP/1.1"
        );
        server.join().unwrap();
    }
}
