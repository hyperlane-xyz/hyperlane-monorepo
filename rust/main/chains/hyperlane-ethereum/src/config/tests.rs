use url::Url;

use super::*;

#[test]
fn test_rpc_urls_http_quorum() {
    let urls = vec![
        Url::parse("http://example.com").unwrap(),
        Url::parse("http://example.org").unwrap(),
    ];
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::HttpQuorum { urls: urls.clone() },
        ..Default::default()
    };

    assert_eq!(conn.rpc_urls(), urls);
}

#[test]
fn test_rpc_urls_http_fallback() {
    let urls = vec![
        Url::parse("http://example.com").unwrap(),
        Url::parse("http://example.org").unwrap(),
    ];
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::HttpFallback { urls: urls.clone() },
        ..Default::default()
    };

    assert_eq!(conn.rpc_urls(), urls);
}

#[test]
fn test_rpc_urls_http() {
    let url = Url::parse("http://example.com").unwrap();
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::Http { url: url.clone() },
        ..Default::default()
    };

    assert_eq!(conn.rpc_urls(), vec![url]);
}

#[test]
#[should_panic(expected = "Websocket connection is not supported")]
fn test_rpc_urls_ws() {
    let url = Url::parse("ws://example.com").unwrap();
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::Ws { url },
        ..Default::default()
    };

    conn.rpc_urls(); // This should panic
}
