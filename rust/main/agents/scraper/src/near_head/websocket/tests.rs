use ethers::types::{Log, H160};
use futures::SinkExt;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::*;
use crate::near_head::source::EvmContracts;

#[tokio::test]
async fn subscription_wakes_on_connect_logs_and_removals_then_reports_disconnect() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
    let contracts = EvmContracts {
        mailbox: H160::repeat_byte(1),
        hook: H160::repeat_byte(2),
        paymaster: H160::repeat_byte(3),
    };
    let filter = contracts.event_filter();
    let expected = serde_json::to_value(&filter)?;
    let (send, mut receive) = mpsc::channel::<bool>(1);
    let server = async {
        let (tcp, _) = listener.accept().await?;
        let mut socket = accept_async(tcp).await?;
        let request: Value = serde_json::from_str(
            socket
                .next()
                .await
                .ok_or_else(|| eyre!("Missing request"))??
                .to_text()?,
        )?;
        assert_eq!(request["method"], "eth_subscribe");
        assert_eq!(request["params"], json!(["logs", expected]));
        assert_eq!(
            expected["address"].as_array().expect("filter array").len(),
            3
        );
        assert_eq!(
            expected["topics"][0]
                .as_array()
                .expect("filter array")
                .len(),
            4
        );
        assert!(expected.get("fromBlock").is_none());
        assert!(expected.get("toBlock").is_none());
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "id": request["id"], "result": "0x1"
                })
                .to_string()
                .into(),
            ))
            .await?;
        while let Some(removed) = receive.recv().await {
            let log = Log {
                removed: Some(removed),
                ..Default::default()
            };
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0", "method": "eth_subscription",
                        "params": { "subscription": "0x1", "result": log }
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
        }
        socket.close(None).await?;
        Ok::<_, eyre::Report>(())
    };
    let wakeup = Notify::new();
    let client = async {
        assert!(subscribe(&url, &filter, &wakeup, 1).await.is_err());
    };
    let consumer = async {
        wakeup.notified().await; // Subscription acknowledgement wakes catch-up.
        for removed in [false, true] {
            send.send(removed).await?;
            wakeup.notified().await;
        }
        drop(send);
        Ok::<_, eyre::Report>(())
    };
    timeout(Duration::from_secs(5), async {
        let (server, (), consumer) = tokio::join!(server, client, consumer);
        server?;
        consumer
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn reconnect_wakes_catchup_after_disconnect() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
    let wakeup = Notify::new();
    let (close_tx, mut close_rx) = mpsc::channel(1);
    let server = async {
        for _ in 0..2 {
            let (tcp, _) = listener.accept().await?;
            let mut socket = accept_async(tcp).await?;
            let request: Value = serde_json::from_str(
                socket
                    .next()
                    .await
                    .ok_or_else(|| eyre!("Missing request"))??
                    .to_text()?,
            )?;
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0", "id": request["id"], "result": "0x1"
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
            close_rx
                .recv()
                .await
                .ok_or_else(|| eyre!("Consumer closed"))?;
            socket.close(None).await?;
        }
        Ok::<_, eyre::Report>(())
    };
    let consumer = async {
        for _ in 0..2 {
            wakeup.notified().await;
            close_tx.send(()).await.expect("server waiting for close");
        }
    };
    timeout(Duration::from_secs(15), async {
        tokio::select! {
            _ = run(Some(url.into()), Filter::new(), &wakeup, 1) => {
                Err(eyre!("WebSocket monitor exited"))
            }
            result = async {
                let (result, ()) = tokio::join!(server, consumer);
                result
            } => result,
        }
    })
    .await??;
    Ok(())
}
