use ethers::types::{Block, Log, H160, H256};
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
    let (send, mut receive) = mpsc::channel::<Option<bool>>(1);
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
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "method": "eth_subscription",
                    "params": { "subscription": "0x1", "result": Log {
                        block_number: Some(40.into()), ..Default::default()
                    }}
                })
                .to_string()
                .into(),
            ))
            .await?;
        acknowledge_heads(&mut socket).await?;
        while let Some(removed) = receive.recv().await {
            let (subscription, result) = match removed {
                Some(removed) => (
                    "0x1",
                    serde_json::to_value(Log {
                        removed: Some(removed),
                        block_number: Some(43.into()),
                        ..Default::default()
                    })?,
                ),
                None => (
                    "0x2",
                    serde_json::to_value(Block::<H256> {
                        number: Some(42.into()),
                        hash: Some(H256::repeat_byte(42)),
                        parent_hash: H256::repeat_byte(41),
                        ..Default::default()
                    })?,
                ),
            };
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0", "method": "eth_subscription",
                        "params": { "subscription": subscription, "result": result }
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
    let wanted = AtomicU64::new(0);
    let (_polled_tx, mut polled_rx) = watch::channel(0);
    let (head_tx, mut head_rx) = mpsc::channel(256);
    let client = async {
        assert!(
            subscribe(&url, &filter, &wakeup, &wanted, &head_tx, &mut polled_rx, 1)
                .await
                .is_err()
        );
    };
    let consumer = async {
        wakeup.notified().await; // Subscription acknowledgement wakes catch-up.
        assert_eq!(wanted.load(Ordering::Relaxed), 40);
        send.send(None).await?;
        let header = head_rx.recv().await.expect("streamed header");
        assert_eq!(header.height, 42);
        assert_eq!(header.hash, H256::repeat_byte(42));
        assert_eq!(header.parent, H256::repeat_byte(41));
        assert!(timeout(Duration::from_millis(20), wakeup.notified())
            .await
            .is_err());
        for removed in [false, true] {
            send.send(Some(removed)).await?;
            wakeup.notified().await;
            assert_eq!(wanted.load(Ordering::Relaxed), 43);
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
    let wanted = AtomicU64::new(0);
    let (_polled_tx, polled_rx) = watch::channel(0);
    let (head_tx, _head_rx) = mpsc::channel(256);
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
            acknowledge_heads(&mut socket).await?;
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
            _ = run(Some(url.into()), Filter::new(), &wakeup, &wanted, &head_tx, polled_rx, 1) => {
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

async fn acknowledge_heads(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Result<()> {
    let request: Value = serde_json::from_str(
        socket
            .next()
            .await
            .ok_or_else(|| eyre!("Missing head subscription"))??
            .to_text()?,
    )?;
    assert_eq!(request["method"], "eth_subscribe");
    assert_eq!(request["params"], json!(["newHeads"]));
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": request["id"], "result": "0x2"
            })
            .to_string()
            .into(),
        ))
        .await?;
    Ok(())
}

#[tokio::test]
async fn stalled_subscription_times_out_only_after_poll_progress_without_probe_rpcs() -> Result<()>
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
    let wakeup = Notify::new();
    let wanted = AtomicU64::new(0);
    let (head_tx, mut head_rx) = mpsc::channel(1);
    let (deliver_tx, mut deliver_rx) = mpsc::channel::<u64>(1);
    let (polled_tx, mut polled_rx) = watch::channel(100);
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
    let server = async {
        let (tcp, _) = listener.accept().await?;
        let mut socket = accept_async(tcp).await?;
        let request: Value = serde_json::from_str(
            socket
                .next()
                .await
                .ok_or_else(|| eyre!("Missing logs request"))??
                .to_text()?,
        )?;
        assert_eq!(request["method"], "eth_subscribe");
        assert_eq!(request["params"][0], "logs");
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "id": request["id"], "result": "0x1"
                })
                .to_string()
                .into(),
            ))
            .await?;
        acknowledge_heads(&mut socket).await?;
        // Delivery is controlled separately from the open socket.
        // Any further RPC would be a forbidden liveness probe.
        loop {
            tokio::select! {
                _ = &mut done_rx => return Ok::<_, eyre::Report>(()),
                Some(height) = deliver_rx.recv() => {
                    socket.send(Message::Text(json!({
                        "jsonrpc": "2.0", "method": "eth_subscription",
                        "params": { "subscription": "0x2", "result": Block::<H256> {
                            number: Some(height.into()), hash: Some(H256::from_low_u64_be(height)),
                            ..Default::default()
                        }}
                    }).to_string().into())).await?;
                }
                message = socket.next() => match message {
                    Some(Ok(Message::Text(request))) => panic!("Unexpected probe RPC: {request}"),
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    // The timeout now drops its owned transport immediately.
                    Some(Err(_)) => return Ok(()),
                    _ => {},
                }
            }
        }
    };
    let client = async {
        let error = subscribe(
            &url,
            &Filter::new(),
            &wakeup,
            &wanted,
            &head_tx,
            &mut polled_rx,
            1,
        )
        .await
        .expect_err("stalled subscription must end");
        assert_eq!(
            error.to_string(),
            "Head subscription stalled behind polling"
        );
        let finished = tokio::time::Instant::now();
        let _ = done_tx.send(());
        finished
    };
    let observer = async {
        wakeup.notified().await;
        tokio::time::pause();
        // No new blocks: an otherwise silent connection is still legitimate.
        sleep(HEAD_STALL_TIMEOUT * 2).await;
        polled_tx.send_replace(101);
        sleep(Duration::from_secs(10)).await;
        // A delivered header catches up and cancels the pending timeout.
        tokio::time::resume();
        deliver_tx.send(101).await.expect("server alive");
        assert_eq!(head_rx.recv().await.expect("header delivered").height, 101);
        tokio::time::pause();
        sleep(HEAD_STALL_TIMEOUT * 2).await;
        let started = tokio::time::Instant::now();
        polled_tx.send_replace(102);
        sleep(Duration::from_secs(10)).await;
        // Repeated observations cannot extend the original deadline.
        polled_tx.send_replace(103);
        sleep(Duration::from_secs(10)).await;
        polled_tx.send_replace(104);
        started
    };
    timeout(Duration::from_secs(240), async {
        let (result, finished, started) = tokio::join!(server, client, observer);
        // Tokio timers round to milliseconds after the real socket exchange.
        let elapsed = finished.duration_since(started);
        assert!(
            (HEAD_STALL_TIMEOUT..HEAD_STALL_TIMEOUT + Duration::from_millis(100))
                .contains(&elapsed)
        );
        result
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn subscription_timeouts_close_the_socket_including_a_pending_second_request() -> Result<()> {
    for pending in [1, 2] {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
        let wakeup = Notify::new();
        let wanted = AtomicU64::new(0);
        let (_polled_tx, mut polled_rx) = watch::channel(0);
        let (head_tx, _head_rx) = mpsc::channel(1);
        let server = async {
            let (tcp, _) = listener.accept().await?;
            let mut socket = accept_async(tcp).await?;
            for id in 1..=pending {
                let request: Value = serde_json::from_str(
                    socket
                        .next()
                        .await
                        .ok_or_else(|| eyre!("Missing request"))??
                        .to_text()?,
                )?;
                assert_eq!(request["id"], id);
                if id < pending {
                    socket
                        .send(Message::Text(
                            json!({
                                "jsonrpc": "2.0", "id": id, "result": "0x1"
                            })
                            .to_string()
                            .into(),
                        ))
                        .await?;
                }
            }
            tokio::time::pause();
            // No reply: timeout must drop the transport, not leave a detached task.
            assert!(matches!(
                socket.next().await,
                None | Some(Err(_)) | Some(Ok(Message::Close(_)))
            ));
            Ok::<_, eyre::Report>(())
        };
        let client = async {
            let result = subscribe(
                &url,
                &Filter::new(),
                &wakeup,
                &wanted,
                &head_tx,
                &mut polled_rx,
                1,
            )
            .await;
            tokio::time::resume();
            assert!(result.is_err());
        };
        let (result, ()) = tokio::join!(server, client);
        result?;
    }
    Ok(())
}
