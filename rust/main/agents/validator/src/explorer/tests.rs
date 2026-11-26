use super::*;
use axum::{routing::post, Json, Router};
use hyperlane_core::Checkpoint;
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

pub(crate) fn fixture(request: Value, snapshot_count: u32, tip: u32) -> Value {
    let vars = &request["variables"];
    let domain = vars["domain"].to_string();
    let hook = &vars["hook"];
    if request["query"]
        .as_str()
        .expect("query")
        .contains("merkle_tree_snapshot")
    {
        let tree = fixture_tree(snapshot_count);
        return json!({"data":{"merkle_tree_snapshot":{
            "domain":domain, "merkle_tree_hook":hook, "leaf_count":snapshot_count.to_string(),
            "confirmed_height":"100","root":format!("{:#x}", tree.root()), "branch":tree.branch
        }}});
    }
    let from = vars["from"].as_u64().expect("from");
    let limit = vars["limit"].as_u64().expect("limit");
    assert!((1..=1000).contains(&limit));
    let rows: Vec<_> = (from..from.saturating_add(limit).min(u64::from(tip))).map(|i| json!({
        "domain":domain, "merkle_tree_hook":hook, "leaf_index":i.to_string(), "block_number":"100",
        "message_id":format!(r"\x{:x}",H256::from_low_u64_be(i.saturating_add(1)))
    })).collect();
    json!({"data":{"merkle_tree_insertions":{"insertions":rows}}})
}

fn fixture_tree(count: u32) -> IncrementalMerkle {
    let mut tree = IncrementalMerkle::default();
    for i in 1..=count {
        tree.ingest(H256::from_low_u64_be(u64::from(i)));
    }
    tree
}

#[tokio::test]
async fn bootstrap_authenticates_last_leaf_and_full_rpc_threshold() {
    let hook = H256::repeat_byte(7);
    for count in [1, 2, 3, 8, 9] {
        let api = serve(move |r| fixture(r, count, 12), 10, hook).await;
        let (tree, _) = api.snapshot().await.expect("query").expect("snapshot");
        let vote = |n| CheckpointAtBlock {
            checkpoint: Checkpoint {
                mailbox_domain: 10,
                merkle_tree_hook_address: hook,
                index: n - 1,
                root: fixture_tree(n).root(),
            },
            block_height: None,
        };
        let mut impossible = vote(count);
        impossible.checkpoint.index = u32::MAX;
        let votes = [vote(count), vote(12), impossible];
        let start = api
            .verified_start(tree.clone(), &votes, 2)
            .await
            .expect("both finalized votes");
        assert_eq!(start.previous_tree.root(), fixture_tree(count - 1).root());
        let mut wrong = votes;
        wrong[1].checkpoint.root = H256::repeat_byte(99);
        assert!(api.verified_start(tree.clone(), &wrong, 2).await.is_err());
        // A malicious server can supply a self-consistent tree and last message
        // for a different history. Neither can pass an independent RPC root.
        if count > 1 {
            let mut forged = IncrementalMerkle::default();
            for _ in 1..count {
                forged.ingest(H256::repeat_byte(99));
            }
            forged.ingest(H256::from_low_u64_be(u64::from(count)));
            assert!(api.verified_start(forged, &[vote(count)], 1).await.is_err());
        }
        let bad_leaf = serve(
            move |r| {
                let mut data = fixture(r, count, 12);
                data["data"]["merkle_tree_insertions"]["insertions"][0]["message_id"] =
                    json!(H256::repeat_byte(99));
                data
            },
            10,
            hook,
        )
        .await;
        assert!(bad_leaf
            .verified_start(tree, &[vote(count)], 1)
            .await
            .is_err());
    }
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
            fixture(request, 8, 1010)
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
        ("block_number", "4294967296"),
    ] {
        let api = serve(
            move |r| {
                let mut data = fixture(r, 8, 10);
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
