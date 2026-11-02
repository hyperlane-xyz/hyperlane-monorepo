use url::Url;

use super::*;

#[test]
fn mev_submission_protects_reveals_for_every_configured_router_only() {
    let primary = H256::from_low_u64_be(1);
    let additional = H256::from_low_u64_be(2);
    let policy = MevSubmissionConfig {
        rpc_urls: vec![Url::parse("https://protected.example").unwrap()].into(),
        ica_router: primary,
        additional_ica_routers: vec![additional],
    };
    for recipient in [primary, additional] {
        for sender in [H256::zero(), H256::from_low_u64_be(99)] {
            let mut message = HyperlaneMessage {
                sender,
                recipient,
                body: vec![2; 65],
                ..Default::default()
            };
            assert!(policy.matches(&message));
            for body in [vec![], vec![0; 65], vec![1; 129]] {
                message.body = body;
                assert!(!policy.matches(&message));
            }
        }
    }
    assert!(!policy.matches(&HyperlaneMessage {
        recipient: H256::from_low_u64_be(3),
        body: vec![2; 65],
        ..Default::default()
    }));
}

#[test]
fn test_rpc_urls_http_quorum() {
    let urls = vec![
        Url::parse("http://example.com").unwrap(),
        Url::parse("http://example.org").unwrap(),
    ];
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::HttpQuorum {
            urls: urls.clone().into(),
        },
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
        rpc_connection: RpcConnectionConf::HttpFallback {
            urls: urls.clone().into(),
        },
        ..Default::default()
    };

    assert_eq!(conn.rpc_urls(), urls);
}

#[test]
fn test_rpc_urls_http() {
    let url = Url::parse("http://example.com").unwrap();
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::Http {
            url: url.clone().into(),
        },
        ..Default::default()
    };

    assert_eq!(conn.rpc_urls(), vec![url]);
}

#[test]
#[should_panic(expected = "Websocket connection is not supported")]
fn test_rpc_urls_ws() {
    let url = Url::parse("ws://example.com").unwrap();
    let conn = ConnectionConf {
        rpc_connection: RpcConnectionConf::Ws { url: url.into() },
        ..Default::default()
    };

    conn.rpc_urls(); // This should panic
}
