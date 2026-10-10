use super::*;
use hyper::{
    service::{make_service_fn, service_fn},
    Server,
};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

async fn server<F>(respond: F) -> (String, tokio::task::JoinHandle<()>)
where
    F: Fn(Request<Body>) -> Response<Body> + Send + Sync + 'static,
{
    let respond = Arc::new(respond);
    let server = Server::bind(&([127, 0, 0, 1], 0).into()).serve(make_service_fn(move |_| {
        let respond = respond.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request| {
                let response = respond(request);
                async { Ok::<_, Infallible>(response) }
            }))
        }
    }));
    let endpoint = format!("http://{}", server.local_addr());
    (endpoint, tokio::spawn(async move { server.await.unwrap() }))
}

#[tokio::test]
async fn accepts_only_bodies_below_exclusive_limit_for_success_and_errors() {
    for status in [
        StatusCode::OK,
        StatusCode::NOT_FOUND,
        StatusCode::FORBIDDEN,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        for size in [
            0,
            MAX_CHECKPOINT_OBJECT_SIZE - 1,
            MAX_CHECKPOINT_OBJECT_SIZE,
            MAX_CHECKPOINT_OBJECT_SIZE + 1,
        ] {
            let response = Response::builder()
                .status(status)
                .body(Body::from(vec![0; size]))
                .unwrap();
            let result = collect_response(response).await;
            assert_eq!(
                result.is_ok(),
                size < MAX_CHECKPOINT_OBJECT_SIZE,
                "status={status} size={size}"
            );
            if let Ok(response) = result {
                assert_eq!(response.body().len(), size);
            }
        }
    }
}

#[tokio::test]
async fn caps_chunked_body_without_content_length_before_consuming_stream() {
    let polled = Arc::new(AtomicUsize::new(0));
    let count = polled.clone();
    let stream = futures::stream::iter((0..102_400).map(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok::<_, Infallible>(Bytes::from_static(&[0; 1024]))
    }));
    let response = Response::new(Body::wrap_stream(stream));
    let error = collect_response(response).await.unwrap_err();
    assert!(error.to_string().contains("limit"));
    assert_eq!(polled.load(Ordering::SeqCst), 50);
}

#[tokio::test]
async fn does_not_trust_content_length_and_propagates_body_errors() {
    let response = Response::builder()
        .header("content-length", "1")
        .body(Body::from(vec![0; MAX_CHECKPOINT_OBJECT_SIZE]))
        .unwrap();
    assert!(collect_response(response).await.is_err());
    let stream = futures::stream::iter([Err::<Bytes, _>(std::io::Error::other("broken body"))]);
    assert!(collect_response(Response::new(Body::wrap_stream(stream)))
        .await
        .is_err());
}

#[tokio::test]
async fn anonymous_and_authenticated_requests_use_same_capped_transport() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let (endpoint, task) = server(move |request| {
        let index = observed.fetch_add(1, Ordering::SeqCst);
        if index == 0 {
            assert!(!request.headers().contains_key("authorization"));
        } else {
            assert_eq!(
                request.headers()["authorization"],
                "Bearer local-test-token"
            );
        }
        Response::new(Body::from(vec![0; MAX_CHECKPOINT_OBJECT_SIZE]))
    })
    .await;
    let mut client = StorageClient::new(AuthFlow::NoAuth).await.unwrap();
    assert!(client
        .send(Request::get(&endpoint).body(Body::empty()).unwrap())
        .await
        .is_err());
    client.auth = Some(
        yup_oauth2::AccessTokenAuthenticator::with_client(
            "local-test-token".to_owned(),
            client.http.clone(),
        )
        .build()
        .await
        .unwrap(),
    );
    assert!(client
        .send(Request::get(&endpoint).body(Body::empty()).unwrap())
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn deadline_covers_stalled_headers() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let client = StorageClient::new(AuthFlow::NoAuth).await.unwrap();
    let result = client
        .send_with_timeout(
            Request::get(format!("http://{addr}"))
                .body(Body::empty())
                .unwrap(),
            Duration::from_millis(200),
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("deadline"));
    task.abort();
}

#[tokio::test]
async fn deadline_covers_body_without_eof() {
    let (endpoint, task) = server(|_| {
        Response::new(Body::wrap_stream(futures::stream::pending::<
            Result<Bytes, Infallible>,
        >()))
    })
    .await;
    let client = StorageClient::new(AuthFlow::NoAuth).await.unwrap();
    let result = client
        .send_with_timeout(
            Request::get(&endpoint).body(Body::empty()).unwrap(),
            Duration::from_millis(200),
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("deadline"));
    task.abort();
}

#[test]
fn nested_paths_are_encoded_and_invalid_names_fail() {
    let oid = object_id("valid.bucket", "nested/chain/checkpoint_1_with_id.json").unwrap();
    let request = objects::Object::download(&oid, None).unwrap();
    assert!(request
        .uri()
        .to_string()
        .contains("nested%2Fchain%2Fcheckpoint_1_with_id.json"));
    for bucket in [
        "",
        "ab",
        "BAD",
        "a/b",
        "goog-example",
        "google-example",
        "-bad",
        "bad-",
    ] {
        assert!(object_id(bucket, "key").is_err());
    }
    assert!(object_id("valid-bucket", "").is_err());
}

// Generated only for the local OAuth mock; this key has no cloud account.
const TEST_PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDeQLLOsQJHyyZU
8AJ7GPIR3hvo9Zz0U9dzR+go/WCqejSW486lr5KfuzqFgeyGX87j22HzezQzmQW3
2r+Nrd30hdop2UvTtt1bleG9F4ZH3cDpPnpuki2DXIHcGjlNuO7JXufSCDxCEd91
wjwZNc230TlNBMgKldDrs6ncnfCcoZwGan0lSCErwHwU0KFi8BPjI+OTBERa65+/
M/Sz60Kb21yziiO6sUF4z7xdbdHRSk+dP93JqVoJelE2xIxchDTr6XuK2HnO/qLx
slbiqpcjia/TaJsZPt9PaOPiGtedVCBf9s+4qBoSCMYV5daMcdhQCvvGdZe+Uz++
t63DdpepAgMBAAECggEAWc+FMfbfeAmEpOAT8JBlCYlad+oAkc7rij8tdprlHB6j
77GAyP1I39k1zctxu98taHA3hb9smcklQWVY8LSos23/edfAR35mtuK7RMEj1xiq
ItbHfLT/RUz1gO7r5xdrDt6WCQ6g4wX76cciqAFQ7w3R/OiIuZZOxWBlrKv6FiCL
PW4QYxRkNZowMPcbHBROIET4xIMj8ns+6911Tb+fEcoKDabttks6+qCBsShUIVB6
yYmZoA7XzfDqY50sj8oUy1OamaSfRznbU67WPd25XtM/o5Jq734qCI3U+VZ90rrO
JWYpc1HzqCwsbzcF9skasfLqKLPsKK3NPojnvkWLgQKBgQD6ZPaZG5rWKRWXb6+R
Vl16fu97m4z33/xtN+XSoJf8gfEaqt/T5L/e2UOQ/FYROMQeKPDRUlrVq1570KiB
LTwBiqhZ2bJAenqa7/gFFJsUrGZNoUWrDfpeX8k9B/CQVIN6XLJT9AIoCVdlTKYs
Ad8EqzFeNqaHKcaGeQwI2izx+QKBgQDjOnPOOAy1gdZTu1wCPlKQ1zKHy0V0FAMv
GIg/N92dLvfDgFZzZZuwOlfrI3Bry1rWbIrzbtMYc7dbIYAZyo9K8W12l1Zfui2H
heW5JL26ZBHahHnQ47YDYSsnnAEqOXzITsyXISw+UkbJ26s0g6RWgnNSnF1tAZvB
iKiOz9A/MQKBgAVbR5M67fMK6fVVZFIdoN5P/NuOFlPvLL1BZt88pEO4m+nQIf2s
dRZVW4asf0LbDgb/JTe1JVBQ3DKV4iTxTMlTqApUB+YtOJY77/hb2n10urOKca0Z
HXQLZIiztMfBpxZlCUOWgr1Mhdwa6asjVxwIdYPoc2OM1zxlNoax9CgxAoGAY+82
NVDzTfSPZX32RkpQl8D9STm+DwIqMFFSwrL4NYQNlZ7g5pmeclAGkLSiYdYq2jkc
l1l7X7qsvliqdS1f/e7WXJzMcQd5tKvPz7B3/Py72WYACT3MtAnNJ/t1i7OCzLnT
Qvhk8/fNiEOjNVJcOWvf+koo0KMvdFt8/mopRVECgYBlHfJnWyEa0ChSduF63vjB
HxfS5EmpIiTCBaWbGLFvcE5Q3lLQ8hlSIu0Uneej+Dm7AvkyK5ILqRHJG1eUVGzo
3Ru5JSLSlB2xUKJI2m0VkiW7PaSapeXWqE9dM+z3aY367uXxV4acF0za9P8eTbvK
FvCMcMSZu8GCwbULV9QKhg==
-----END PRIVATE KEY-----
"#;

fn service_account_file(token_uri: &str) -> tempfile::NamedTempFile {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        "{}",
        serde_json::json!({
            "type": "service_account", "private_key": TEST_PRIVATE_KEY,
            "client_email": "local-test@example.invalid", "token_uri": token_uri
        })
    )
    .unwrap();
    file
}

#[tokio::test]
async fn service_account_tokens_are_cached_and_refreshable() {
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let (endpoint, task) = server(move |_| {
        let n = seen.fetch_add(1, Ordering::SeqCst);
        Response::new(Body::from(
            serde_json::json!({
                "access_token": format!("token-{n}"), "token_type": "Bearer", "expires_in": 3600
            })
            .to_string(),
        ))
    })
    .await;
    let file = service_account_file(&endpoint);
    let client = StorageClient::new(AuthFlow::ServiceAccount(ServiceAccountAuth::Path(
        file.path().into(),
    )))
    .await
    .unwrap();
    let auth = client.auth.as_ref().unwrap();
    assert_eq!(
        auth.token(&[READ_WRITE_SCOPE]).await.unwrap().token(),
        Some("token-0")
    );
    assert_eq!(
        auth.token(&[READ_WRITE_SCOPE]).await.unwrap().token(),
        Some("token-0")
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        auth.force_refreshed_token(&[READ_WRITE_SCOPE])
            .await
            .unwrap()
            .token(),
        Some("token-1")
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn user_and_impersonated_service_accounts_build_without_downgrading_auth() {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        "{}",
        serde_json::json!({
            "type": "authorized_user", "client_id": "test-id",
            "client_secret": "test-secret", "refresh_token": "test-refresh"
        })
    )
    .unwrap();
    for flow in [
        AuthFlow::UserAccount(file.path().into()),
        AuthFlow::ServiceAccountImpersonation {
            user: file.path().into(),
            email: "local-test@example.invalid".into(),
        },
    ] {
        assert!(StorageClient::new(flow).await.unwrap().auth.is_some());
    }
    assert!(
        StorageClient::new(AuthFlow::UserAccount("/missing/gcs-test.json".into()))
            .await
            .is_err()
    );
}

#[test]
fn env_and_adc_modes_preserve_auth_in_isolated_processes() {
    let file = service_account_file("http://127.0.0.1:1");
    let this_test = "env_and_adc_subprocess";
    for mode in ["env", "adc_file", "adc_metadata", "env_missing"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg(this_test)
            .arg("--ignored")
            .arg("--nocapture")
            .env("HYPERLANE_GCS_AUTH_TEST_MODE", mode);
        if mode == "adc_metadata" || mode == "env_missing" {
            command.env_remove("GOOGLE_APPLICATION_CREDENTIALS");
        } else {
            command.env("GOOGLE_APPLICATION_CREDENTIALS", file.path());
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}

#[tokio::test]
#[ignore = "Run by env_and_adc_modes_preserve_auth_in_isolated_processes"]
async fn env_and_adc_subprocess() {
    let mode = std::env::var("HYPERLANE_GCS_AUTH_TEST_MODE").unwrap();
    let flow = if mode.starts_with("env") {
        ServiceAccountAuth::EnvVar
    } else {
        ServiceAccountAuth::ApplicationDefault
    };
    let client = StorageClient::new(AuthFlow::ServiceAccount(flow)).await;
    if mode == "env_missing" {
        assert!(client.is_err());
    } else {
        assert!(client.unwrap().auth.is_some());
    }
}

#[tokio::test]
async fn before_after_stream_measurement() {
    fn stream(counter: Arc<AtomicUsize>) -> Body {
        Body::wrap_stream(futures::stream::iter((0..102_400).map(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok::<_, Infallible>(Bytes::from_static(&[0; 1024]))
        })))
    }
    let old = Arc::new(AtomicUsize::new(0));
    let old_body = hyper::body::to_bytes(stream(old.clone())).await.unwrap();
    assert_eq!(old_body.len(), 100 * 1024 * 1024);
    assert_eq!(old.load(Ordering::SeqCst), 102_400);
    drop(old_body);
    let new = Arc::new(AtomicUsize::new(0));
    assert!(collect_response(Response::new(stream(new.clone())))
        .await
        .is_err());
    assert_eq!(new.load(Ordering::SeqCst), 50);
    println!("100 MiB fixture: old collector polled 102400 chunks and retained 104857600 bytes; capped collector polled 50 chunks and rejected the 51200th byte");
}

#[tokio::test]
async fn deadline_includes_token_fetch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let (endpoint, task) = server(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        Response::new(Body::wrap_stream(futures::stream::pending::<
            Result<Bytes, Infallible>,
        >()))
    })
    .await;
    let file = service_account_file(&endpoint);
    let client = StorageClient::new(AuthFlow::ServiceAccount(ServiceAccountAuth::Path(
        file.path().into(),
    )))
    .await
    .unwrap();
    let error = client
        .send_with_timeout(
            Request::get("http://127.0.0.1:1")
                .body(Body::empty())
                .unwrap(),
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("deadline"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn snapshot_download_distinguishes_missing_corrupt_and_transport_errors() {
    use super::super::MAX_MERKLE_SNAPSHOT_SIZE;
    use hyperlane_core::accumulator::incremental::{IncrementalMerkle, MerkleTreeSnapshot};
    let mut tree = IncrementalMerkle::default();
    tree.ingest(hyperlane_core::H256::from_low_u64_be(1));
    let snapshot = MerkleTreeSnapshot::capture(&tree).unwrap();
    let data = serde_json::to_vec(&snapshot).unwrap();
    let (endpoint, task) = server(move |request| {
        assert_eq!(
            request.headers()["authorization"],
            "Bearer snapshot-test-token"
        );
        match request.uri().path() {
            "/valid" => Response::new(Body::from(data.clone())),
            "/missing" => Response::builder().status(404).body(Body::empty()).unwrap(),
            "/forbidden" => Response::builder()
                .status(403)
                .body(Body::from("forbidden"))
                .unwrap(),
            "/corrupt" => Response::new(Body::from("not JSON")),
            "/oversized" => Response::new(Body::from(vec![0; MAX_MERKLE_SNAPSHOT_SIZE])),
            _ => unreachable!(),
        }
    })
    .await;
    let mut client = StorageClient::new(AuthFlow::NoAuth).await.unwrap();
    client.auth = Some(
        yup_oauth2::AccessTokenAuthenticator::with_client(
            "snapshot-test-token".into(),
            client.http.clone(),
        )
        .build()
        .await
        .unwrap(),
    );
    for path in ["valid", "missing", "forbidden", "corrupt", "oversized"] {
        let result = client
            .download(
                Request::get(format!("{endpoint}/{path}"))
                    .body(Body::empty())
                    .unwrap(),
                MAX_MERKLE_SNAPSHOT_SIZE,
            )
            .await;
        match path {
            "valid" => assert_eq!(
                serde_json::from_slice::<MerkleTreeSnapshot>(&result.unwrap().unwrap()).unwrap(),
                snapshot
            ),
            "missing" => assert!(result.unwrap().is_none()),
            "corrupt" => assert!(serde_json::from_slice::<MerkleTreeSnapshot>(
                &result.unwrap().unwrap()
            )
            .is_err()),
            _ => assert!(result.is_err()),
        }
    }
    task.abort();
}

#[tokio::test]
async fn snapshot_limit_is_separate_and_applies_to_chunked_bodies_and_deadlines() {
    use super::super::MAX_MERKLE_SNAPSHOT_SIZE;
    let polled = Arc::new(AtomicUsize::new(0));
    let observed = polled.clone();
    let stream = futures::stream::iter((0..100).map(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok::<_, Infallible>(Bytes::from_static(&[0; 1024]))
    }));
    let response = Response::builder()
        .header("content-length", "1")
        .body(Body::wrap_stream(stream))
        .unwrap();
    assert!(
        collect_response_with_limit(response, MAX_MERKLE_SNAPSHOT_SIZE)
            .await
            .is_err()
    );
    assert_eq!(polled.load(Ordering::SeqCst), 8);
    // A 9 KiB ordinary checkpoint still fits its independent 50 KiB cap.
    assert!(
        collect_response(Response::new(Body::from(vec![0; 9 * 1024])))
            .await
            .is_ok()
    );
    let (endpoint, task) = server(|_| {
        Response::new(Body::wrap_stream(futures::stream::pending::<
            Result<Bytes, Infallible>,
        >()))
    })
    .await;
    let client = StorageClient::new(AuthFlow::NoAuth).await.unwrap();
    let result = client
        .send_with_limits(
            Request::get(&endpoint).body(Body::empty()).unwrap(),
            Duration::from_millis(200),
            MAX_MERKLE_SNAPSHOT_SIZE,
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("deadline"));
    task.abort();
}
