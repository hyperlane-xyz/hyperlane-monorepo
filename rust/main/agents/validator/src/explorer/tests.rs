use super::*;
use axum::{routing::post, Json, Router};
use tokio::net::TcpListener;

pub(crate) async fn serve(
    handler: impl Fn(Value) -> Value + Clone + Send + Sync + 'static,
    domain: u32,
    hook: H256,
) -> Explorer {
    serve_async(
        move |request| std::future::ready(handler(request)),
        domain,
        hook,
    )
    .await
}

pub(crate) async fn serve_async<F: std::future::Future<Output = Value> + Send + 'static>(
    handler: impl Fn(Value) -> F + Clone + Send + Sync + 'static,
    domain: u32,
    hook: H256,
) -> Explorer {
    let app = Router::new().route(
        "/graphql",
        post(move |Json(request): Json<Value>| {
            let response = handler(request);
            async move { Json(response.await) }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let url = format!(
        "http://{}/graphql",
        listener.local_addr().expect("listener address")
    )
    .parse()
    .expect("test URL");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("test server");
    });
    Explorer::new(Secret::new(url), domain, hook).expect("test client")
}

pub(crate) fn fixture(request: Value, tip: u32) -> Value {
    let vars = &request["variables"];
    let domain = vars["domain"].to_string();
    let hook = &vars["hook"];
    let from = vars["from"].as_u64().expect("from");
    let limit = vars["limit"].as_u64().expect("limit");
    assert!((1..=1000).contains(&limit));
    let rows: Vec<_> = (from..from.saturating_add(limit).min(u64::from(tip))).map(|i| json!({
        "domain":domain, "merkle_tree_hook":hook, "leaf_index":i.to_string(), "block_number":"100",
        "message_id":format!(r"\x{:x}",H256::from_low_u64_be(i.saturating_add(1)))
    })).collect();
    json!({"data":{"merkle_tree_insertions":{"insertions":rows}}})
}

#[tokio::test]
async fn pages_check_scope_contiguity_and_limits() {
    let hook = H256::from_low_u64_be(2);
    let api = serve(
        |request| {
            assert!(request["query"]
                .as_str()
                .expect("query")
                .contains("@cached(ttl:$ttl)"));
            assert_eq!(
                request["variables"]["ttl"],
                if request["variables"]["from"] == 0 {
                    60
                } else {
                    2
                }
            );
            assert_eq!(
                request["variables"]["hook"],
                "0x0000000000000000000000000000000000000002"
            );
            fixture(request, 1010)
        },
        1,
        hook,
    )
    .await;
    assert_eq!(api.page(0, 1010).await.expect("first page").len(), 1000);
    let tail = api.page(1000, 1010).await.expect("last page");
    assert_eq!(tail.last().expect("last leaf").0.index(), 1009);
    assert!(api.page(1010, 1011).await.is_err());
    for (field, invalid) in [
        ("leaf_index", "99"),
        ("domain", "99"),
        ("merkle_tree_hook", "99"),
        ("message_id", "99"),
        ("block_number", "18446744073709551616"),
    ] {
        let api = serve(
            move |r| {
                let mut data = fixture(r, 10);
                data["data"]["merkle_tree_insertions"]["insertions"][0][field] = json!(invalid);
                data
            },
            1,
            hook,
        )
        .await;
        assert!(api.page(0, 10).await.is_err(), "{field}");
    }
}
