pub use self::{fallback::*, retrying::*};
use crate::rpc_clients::CategorizedResponse::{NonRetryableErr, RetryableErr};
use ethers::providers::HttpClientError;
use tracing::{info, trace, warn};

mod fallback;
mod retrying;

enum CategorizedResponse<R> {
    IsOk(R),
    RetryableErr(HttpClientError),
    NonRetryableErr(HttpClientError),
}

const METHODS_TO_NOT_RETRY: &[&str] = &["eth_estimateGas"];
const METHOD_TO_NOT_RETRY_WHEN_NOT_SUPPORTED: &[&str] = &["eth_feeHistory"];
const METHODS_TO_NOT_RETRY_ON_REVERT: &[&str] = &["eth_call"];
const METHODS_TO_NOT_RETRY_ON_NONCE_ERROR: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];
const METHODS_TO_NOT_RETRY_ON_ALREADY_KNOWN: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];

fn categorize_client_response<R>(
    method: &str,
    resp: Result<R, HttpClientError>,
) -> CategorizedResponse<R> {
    match resp {
        Ok(res) => {
            trace!("Received Ok response from http client");
            CategorizedResponse::IsOk(res)
        }
        Err(HttpClientError::ReqwestError(e)) => {
            warn!(error=%e, "ReqwestError in http provider");
            RetryableErr(HttpClientError::ReqwestError(e))
        }
        Err(HttpClientError::SerdeJson { err, text }) => {
            warn!(error=%err, text, "SerdeJson error in http provider");
            RetryableErr(HttpClientError::SerdeJson { err, text })
        }
        Err(HttpClientError::JsonRpcError(e)) => {
            // if code: 429 we are being rate limited, try and respect

            let msg = e.message.to_ascii_lowercase();
            // We don't want to retry errors that are probably not going to work if we keep
            // retrying them or that indicate an error in higher-order logic and not
            // transient provider (connection or other) errors.
            if METHODS_TO_NOT_RETRY.contains(&method)
                || (METHOD_TO_NOT_RETRY_WHEN_NOT_SUPPORTED.contains(&method)
                    && msg.contains("support"))
                || (METHODS_TO_NOT_RETRY_ON_REVERT.contains(&method) && msg.contains("revert"))
                || (METHODS_TO_NOT_RETRY_ON_ALREADY_KNOWN.contains(&method)
                    && msg.contains("known"))
                || (METHODS_TO_NOT_RETRY_ON_NONCE_ERROR.contains(&method) && msg.contains("nonce"))
            {
                warn!(error=%e, "Non-retryable JsonRpcError in http provider");
                NonRetryableErr(HttpClientError::JsonRpcError(e))
            } else {
                // the assumption is this is not a "provider error" but rather an invalid
                // request, e.g. nonce too low, not enough gas, ...
                info!(error=%e, "Retryable JsonRpcError in http provider");
                RetryableErr(HttpClientError::JsonRpcError(e))
            }
        }
    }
}
