use std::str::FromStr;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, InvalidHeaderName, InvalidHeaderValue};
use url::Url;

/// Errors that can occur while parsing custom_rpc_header query parameters.
#[derive(Debug, thiserror::Error)]
pub enum ParseCustomRpcHeaderError {
    #[error("invalid header name: {0}")]
    InvalidHeaderName(InvalidHeaderName),
    #[error("invalid header value: {0}")]
    InvalidHeaderValue(InvalidHeaderValue),
}

/// Parse custom_rpc_header query params into a HeaderMap and
/// return a new Url with those custom_rpc_header params removed
/// while preserving order of all other query params.
pub fn parse_custom_rpc_headers(url: &Url) -> Result<(HeaderMap, Url), ParseCustomRpcHeaderError> {
    let mut retained_queries: Vec<(String, String)> = Vec::new();
    let mut headers = HeaderMap::new();

    for (key, value) in url.query_pairs() {
        if key != "custom_rpc_header" {
            retained_queries.push((key.into_owned(), value.into_owned()));
            continue;
        }
        if let Some((header_name_raw, header_value_raw)) = value.split_once(':') {
            let header_name = HeaderName::from_str(header_name_raw)
                .map_err(ParseCustomRpcHeaderError::InvalidHeaderName)?;
            let mut header_value = HeaderValue::from_str(header_value_raw)
                .map_err(ParseCustomRpcHeaderError::InvalidHeaderValue)?;
            header_value.set_sensitive(true);
            headers.insert(header_name, header_value);
        }
    }

    let mut new_url = url.clone();
    if retained_queries.is_empty() {
        new_url.set_query(None);
    } else {
        // Clear then rebuild to preserve order exactly.
        new_url.set_query(None);
        {
            let mut qp = new_url.query_pairs_mut();
            for (k, v) in retained_queries {
                qp.append_pair(&k, &v);
            }
        }
    }

    Ok((headers, new_url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};

    #[test]
    fn test_parse_custom_rpc_headers_valid() {
        let url = Url::parse("http://dummy.local/path?custom_rpc_header=Authorization:Bearer%20abc123&custom_rpc_header=Content-Type:application/json&keep=this").unwrap();
        let (headers, filtered_url) = parse_custom_rpc_headers(&url).unwrap();

        assert_eq!(
            headers.get(AUTHORIZATION).unwrap(),
            &HeaderValue::from_static("Bearer abc123")
        );
        assert_eq!(
            headers.get(CONTENT_TYPE).unwrap(),
            &HeaderValue::from_static("application/json")
        );

        // Ensure non custom_rpc_header query params are preserved.
        assert_eq!(filtered_url.as_str(), "http://dummy.local/path?keep=this");
    }

    #[test]
    fn test_parse_custom_rpc_headers_malformed_and_duplicate() {
        let url = Url::parse(
            "http://dummy.local/?custom_rpc_header=Authorization:FirstToken\
             &custom_rpc_header=BadHeaderNoColon\
             &custom_rpc_header=Authorization:SecondToken\
             &q=1",
        )
        .unwrap();
        let (headers, filtered_url) = parse_custom_rpc_headers(&url).unwrap();

        // Malformed ignored (not present as header, not in queries).
        assert!(!headers.iter().any(|(k, _)| k == "BadHeaderNoColon"));

        // Duplicate Authorization should reflect last (SecondToken).
        assert_eq!(
            headers.get(AUTHORIZATION).unwrap(),
            &HeaderValue::from_static("SecondToken")
        );

        // Non-header query retained.
        assert_eq!(filtered_url.as_str(), "http://dummy.local/?q=1");
    }

    #[test]
    fn test_parse_custom_rpc_headers_none_present() {
        let url = Url::parse("http://dummy.local/svc?foo=bar&baz=qux").unwrap();
        let (headers, filtered_url) = parse_custom_rpc_headers(&url).unwrap();

        assert!(headers.get(AUTHORIZATION).is_none());
        assert!(headers.get(CONTENT_TYPE).is_none());
        assert_eq!(
            filtered_url.as_str(),
            "http://dummy.local/svc?foo=bar&baz=qux"
        );
    }
}
