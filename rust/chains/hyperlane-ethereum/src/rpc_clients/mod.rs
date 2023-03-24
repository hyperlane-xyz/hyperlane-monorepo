use ethers::providers::HttpClientError;
use tracing::{info, trace, warn};

pub use self::{fallback::*, retrying::*};

mod fallback;
mod retrying;

enum CategorizedResponse<R> {
    IsOk(R),
    /// An error that is (probably) not our fault
    RetryableErr(HttpClientError),
    /// retryable error, but caller should backoff
    RateLimitErr(HttpClientError),
    /// An error that will (probably) keep happening no matter how many times we
    /// retry
    NonRetryableErr(HttpClientError),
}

const METHODS_TO_NOT_RETRY: &[&str] = &["eth_estimateGas"];
const METHOD_TO_NOT_RETRY_WHEN_NOT_SUPPORTED: &[&str] = &["eth_feeHistory"];
const METHODS_TO_NOT_RETRY_ON_REVERT: &[&str] = &["eth_call"];
const METHODS_TO_NOT_RETRY_ON_NONCE_ERROR: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];
const METHODS_TO_NOT_RETRY_ON_ALREADY_KNOWN: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];
const METHODS_TO_NOT_RETRY_ON_UNDERPRICED: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];
const METHODS_TO_NOT_RETRY_ON_INSUFFICIENT_FUNDS: &[&str] =
    &["eth_sendRawTransaction", "eth_sendTransaction"];

/// Figure out how best to handle a response from an HTTP client.
///
/// Caller is responsible for adding a log span with additional context.
///
///
/// # GCP Query to explore errors
/// severity=WARNING
/// jsonPayload.target=~"hyperlane_ethereum::(retrying|fallback)"
/// (jsonPayload.span.method=~".*eth_.*" OR
/// jsonPayload.fields.method=~".*eth_.*") -jsonPayload.fields.text="{\"message\
/// ":\"no Route matched with those values\"}" -jsonPayload.fields.error=~".*
/// connection closed before message completed.*" -jsonPayload.fields.error=~".*
/// tcp connect error.*" -jsonPayload.fields.text="<html>\r\n<head><title>502
/// Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad
/// Gateway</h1></center>\r\n</body>\r\n</html>\r\n" -jsonPayload.fields.error="(code: 429, message: Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput, data: None)"
/// -jsonPayload.fields.text="default backend - 404"
/// -jsonPayload.fields.text="Bad Gateway"
/// -jsonPayload.fields.error=~".*Connection reset by peer (os error 104)"
/// -jsonPayload.fields.text="API call rejected because chain is not done
/// bootstrapping" -jsonPayload.fields.error="(code: -32601, message: the method
/// eth_feeHistory does not exist/is not available, data: None)" -jsonPayload.
/// target="hyperlane_ethereum::fallback" -jsonPayload.fields.error=~"operation
/// timed out" -jsonPayload.fields.error="(code: -32000, message: 404 Not Found:
/// {\"jsonrpc\":\"2.0\",\"error\":{\"code\":404,\"message\":\"arb1-sequencer
/// rate limit hit.  Try again 1 minute\"}}, data: None)" -jsonPayload.fields.
/// error="(code: -32000, message: 429 Too Many Requests:
/// {\"jsonrpc\":\"2.0\",\"error\":{\"code\":429,\"message\":\"Public RPC Rate
/// Limit Hit, limit will reset in 60 seconds\"}}, data: None)" -jsonPayload.
/// fields.error=~"unable to get local issuer certificate" -jsonPayload.fields.
/// error="EOF while parsing a value at line 1 column 0" -jsonPayload.fields.
/// text="internal service failure\n" -jsonPayload.fields.text="<html>\r\
/// n<head><title>503 Service Temporarily
/// Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily
/// Unavailable</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</
/// html>\r\n" -jsonPayload.fields.text="<html>\r\n<head><title>502 Bad
/// Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad
/// Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\
/// n" -jsonPayload.fields.error=~"error trying to connect: error:14094410:SSL
/// routines:ssl3_read_bytes:sslv3 alert handshake
/// failure:../ssl/record/rec_layer_s3.c:1543:SSL alert number 40" -jsonPayload.
/// fields.text=~"The gateway cannot get a response, please try again or contact
/// the administrator" -jsonPayload.fields.error=~"Connection reset by peer \(os
/// error 104\)" -jsonPayload.fields.text="<html>\r\n<head><title>502 Bad
/// Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad
/// Gateway</h1></center>\r\n<hr><center>cloudflare</center>\r\n</body>\r\n</
/// html>\r\n" -jsonPayload.fields.text="{\"jsonrpc\":\"2.0\",\"error\":{\"code\
/// ":0,\"message\":\"we can't execute this request\"},\"id\":null}"
/// -jsonPayload.fields.error="(code: -32000, message: transaction underpriced,
/// data: None)" -jsonPayload.fields.error="(code: -32000, message: replacement
/// transaction underpriced, data: None)" -jsonPayload.fields.text="{\"jsonrpc\"
/// :\"2.0\",\"result\":{\"code\":429,\"message\":\"Total number of requests
/// exceeded. Want higher rate limit? Contact us at
/// sales@gateway.fm\"},\"id\":\"\"}" -jsonPayload.fields.text="<html>\r\
/// n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502
/// Bad Gateway</h1></center>\r\n<hr><center>nginx/1.20.2</center>\r\n</body>\r\
/// n</html>\r\n" -jsonPayload.fields.text=~"504 ERROR"
/// -jsonPayload.fields.text="Gateway Timeout"
/// -jsonPayload.fields.text="404 page not found\n"
/// -jsonPayload.fields.error=~"error trying to connect: unexpected EOF"
/// -jsonPayload.fields.error=~"execution reverted: No router enrolled for
/// domain. Did you specify the right domain ID?" -jsonPayload.fields.error=~"VM
/// Exception while processing transaction: revert No router enrolled for
/// domain. Did you specify the right domain ID?" -jsonPayload.fields.error="
/// (code: -32000, message: invalid transaction: nonce too low, data: None)"
/// -jsonPayload.fields.error="(code: -32000, message: already known, data:
/// None)" -jsonPayload.fields.error="(code: -32010, message: AlreadyKnown,
/// data: None)" -jsonPayload.fields.error=~"message: nonce too low"
/// -jsonPayload.fields.error=~"message: execution reverted: delivered"
/// -jsonPayload.fields.error="(code: -32603, message: already known, data:
/// None)" -jsonPayload.fields.error="(code: -32000, message: ALREADY_EXISTS:
/// already known, data: None)" -jsonPayload.fields.text="{\n  \"message\":\"An
/// invalid response was received from the upstream server\"\n}"
fn categorize_client_response<R>(
    method: &str,
    resp: Result<R, HttpClientError>,
) -> CategorizedResponse<R> {
    use CategorizedResponse::*;
    use HttpClientError::*;
    match resp {
        Ok(res) => {
            trace!("Received Ok response from http client");
            IsOk(res)
        }
        Err(ReqwestError(e)) => {
            warn!(error=%e, "ReqwestError in http provider");
            RetryableErr(ReqwestError(e))
        }
        Err(SerdeJson { err, text }) => {
            if text.contains("429") {
                warn!(error=%err, text, "Received rate limit request SerdeJson error in http provider");
                RateLimitErr(SerdeJson { err, text })
            } else {
                warn!(error=%err, text, "SerdeJson error in http provider");
                RetryableErr(SerdeJson { err, text })
            }
        }
        Err(JsonRpcError(e)) => {
            let msg = e.message.to_ascii_lowercase();
            if e.code == 429
                || msg.contains("429")
                || msg.contains("rate limit")
                || msg.contains("too many requests")
            {
                info!(error=%e, "Received rate limit request JsonRpcError in http provider");
                RateLimitErr(JsonRpcError(e))
            } else if METHODS_TO_NOT_RETRY.contains(&method)
                || (METHOD_TO_NOT_RETRY_WHEN_NOT_SUPPORTED.contains(&method)
                    && msg.contains("support"))
                || (METHODS_TO_NOT_RETRY_ON_REVERT.contains(&method) && msg.contains("revert"))
                || (METHODS_TO_NOT_RETRY_ON_ALREADY_KNOWN.contains(&method)
                    && msg.contains("known"))
                || (METHODS_TO_NOT_RETRY_ON_NONCE_ERROR.contains(&method) && msg.contains("nonce"))
                || (METHODS_TO_NOT_RETRY_ON_UNDERPRICED.contains(&method)
                    && msg.contains("underpriced"))
                || (METHODS_TO_NOT_RETRY_ON_INSUFFICIENT_FUNDS.contains(&method)
                    && msg.contains("insufficient funds"))
            {
                // We don't want to retry errors that are probably not going to work if we keep
                // retrying them or that indicate an error in higher-order logic and not
                // transient provider (connection or other) errors.
                warn!(error=%e, "Non-retryable JsonRpcError in http provider");
                NonRetryableErr(JsonRpcError(e))
            } else {
                // the assumption is this is not a "provider error" but rather an invalid
                // request, e.g. nonce too low, not enough gas, ...
                info!(error=%e, "Retryable JsonRpcError in http provider");
                RetryableErr(JsonRpcError(e))
            }
        }
    }
}
