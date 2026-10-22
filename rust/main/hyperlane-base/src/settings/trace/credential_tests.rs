use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use aws_sdk_s3::{
    config::{Credentials, Region},
    presigning::PresigningConfig,
    Client, Config,
};
use hyperlane_core::{Secret, H256};
use tracing::Subscriber;
use tracing_subscriber::{fmt, prelude::*, Registry};

use super::{fmt::Style, Level, TracingConfig};
use crate::settings::{parser::RawAgentConf, SignerConf};

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn subscriber(style: Style, level: Level, buffer: Buffer) -> impl Subscriber + Send + Sync {
    let writer = move || buffer.clone();
    let layer = fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(writer);
    let layer = match style {
        Style::Full => layer.boxed(),
        Style::Compact => layer.compact().boxed(),
        Style::Pretty => layer.pretty().boxed(),
        Style::Json => layer.json().boxed(),
    };
    Registry::default()
        .with(TracingConfig { fmt: style, level }.targets())
        .with(layer)
}

#[tokio::test(flavor = "current_thread")]
async fn credentials_are_redacted_in_all_log_formats_without_breaking_aws_signing() {
    let _ = tracing_log::LogTracer::init();
    let credentials = Credentials::new(
        "DUMMY_ACCESS_ID",
        "DUMMY_AWS_SECRET",
        Some("DUMMY_AWS_SESSION".to_owned()),
        None,
        "test",
    );
    let client = Client::from_conf(
        Config::builder()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .credentials_provider(credentials.clone())
            .build(),
    );
    let key = H256::repeat_byte(0xab);
    let signer = SignerConf::HexKey {
        key: Secret::new(key),
    };
    let raw: RawAgentConf = serde_json::from_value(serde_json::json!({
        "aws_secret_access_key": "DUMMY_AWS_SECRET",
        "aws_session_token": "DUMMY_AWS_SESSION",
        "validator": { "key": format!("{key:x}") }
    }))
    .unwrap();

    for style in [Style::Full, Style::Compact, Style::Pretty, Style::Json] {
        for level in [Level::Debug, Level::Trace, Level::DependencyTrace] {
            let buffer = Buffer::default();
            let guard = tracing::subscriber::set_default(subscriber(style, level, buffer.clone()));
            let span = tracing::info_span!("credential_config", ?raw, ?signer);
            let entered = span.enter();
            tracing::info!(
                chain = "ethereum",
                height = 42,
                "checkpoint signing remains observable"
            );
            let mut kms_request = rusoto_core::signature::SignedRequest::new(
                "POST",
                "kms",
                &rusoto_core::Region::UsEast1,
                "/",
            );
            kms_request.sign(&rusoto_core::credential::AwsCredentials::new(
                "DUMMY_ACCESS_ID",
                "DUMMY_AWS_SECRET",
                Some("DUMMY_AWS_SESSION".to_owned()),
                None,
            ));
            assert_eq!(
                kms_request.headers["x-amz-security-token"][0],
                b"DUMMY_AWS_SESSION"
            );
            let presigned = client
                .get_object()
                .bucket("dummy-bucket")
                .key("checkpoint.json")
                .presigned(PresigningConfig::expires_in(Duration::from_secs(60)).unwrap())
                .await
                .unwrap();
            // Request signing still receives the complete credentials. No network calls.
            assert!(presigned.uri().contains("DUMMY_ACCESS_ID"));
            assert!(presigned.uri().contains("DUMMY_AWS_SESSION"));
            drop(entered);
            drop(span);
            drop(guard);
            let output = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
            for secret in [
                "DUMMY_ACCESS_ID",
                "DUMMY_AWS_SECRET",
                "DUMMY_AWS_SESSION",
                "abababab",
            ] {
                assert!(
                    !output.contains(secret),
                    "credential leaked in {style:?}/{level:?}: {secret}"
                );
            }
            assert!(output.contains("[REDACTED"));
            assert!(output.contains("checkpoint signing remains observable"));
            assert!(output.contains("ethereum"));
            assert!(output.contains("42"));
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn starknet_failures_identify_same_host_endpoints_without_credentials() {
    use hyperlane_core::{HyperlaneDomain, HyperlaneProvider};
    use hyperlane_metric::prometheus_metric::ChainInfo;
    use hyperlane_starknet::{ConnectionConf, StarknetProvider};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let conf = ConnectionConf {
        urls: Secret::new(
            (0..2)
                .map(|index| {
                    format!("http://private-user:private-password@{address}/private-path-{index}?key=private-query#private-fragment")
                        .parse()
                        .unwrap()
                })
                .collect(),
        ),
        native_token_address: H256::zero(),
        op_submission_config: Default::default(),
    };
    let provider = StarknetProvider::new(
        HyperlaneDomain::new_test_domain("starknet"),
        &conf,
        Default::default(),
        Some(ChainInfo {
            name: Some("starknet-test".to_owned()),
        }),
    )
    .unwrap();

    for style in [Style::Full, Style::Compact, Style::Pretty, Style::Json] {
        let buffer = Buffer::default();
        let guard =
            tracing::subscriber::set_default(subscriber(style, Level::Warn, buffer.clone()));
        assert!(provider.get_block_by_height(1).await.is_err());
        drop(guard);
        let output = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert!(
            !output.contains("private-"),
            "credentials leaked in {style:?}"
        );
        assert!(output.contains(&address.to_string()));
        assert!(output.contains("starknet-test"));
        assert!(output.contains("rpcUrls"));
        if matches!(style, Style::Json) {
            let failures: Vec<serde_json::Value> = output
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .filter(|event: &serde_json::Value| {
                    event["fields"]["message"] == "Got error from inner fallback provider"
                })
                .collect();
            assert_eq!(failures.len(), 8);
            for (attempt, event) in failures.iter().enumerate() {
                assert_eq!(event["span"]["rpc_index"], attempt % 2);
                assert_eq!(event["span"]["rpc_host"], address.to_string());
                assert_eq!(event["span"]["chain"], "starknet-test");
                assert_eq!(event["span"]["rpc_pool"], "rpcUrls");
                assert_eq!(event["fields"]["method"], "GetBlockWithTxHashes");
            }
        }
    }
}
