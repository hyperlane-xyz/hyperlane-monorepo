use ethers::types::{Block, Log, H256};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, WebSocketStream};

use super::*;
use crate::near_head::source::EvmContracts;

type Socket = WebSocketStream<TcpStream>;

async fn request(socket: &mut Socket) -> Result<Value> {
    Ok(serde_json::from_str(
        socket
            .next()
            .await
            .ok_or_else(|| eyre!("Missing request"))??
            .to_text()?,
    )?)
}

async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    Ok(socket.send(Message::Text(value.to_string().into())).await?)
}

async fn notification(socket: &mut Socket, id: &str, result: impl Serialize) -> Result<()> {
    send(
        socket,
        json!({"jsonrpc":"2.0", "method":"eth_subscription",
        "params":{"subscription":id, "result":result}}),
    )
    .await
}

#[tokio::test]
async fn filtered_logs_headers_and_stall_recovery_use_one_owned_connection() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
    let filter = EvmContracts {
        mailbox: Default::default(),
        hook: Default::default(),
        paymaster: Default::default(),
    }
    .event_filter();
    let wakeup = Notify::new();
    let wanted = AtomicU64::new(0);
    let (polled_tx, mut polled_rx) = watch::channel(0);
    let (head_tx, mut head_rx) = mpsc::channel(1);
    let server = async {
        let mut socket = accept_async(listener.accept().await?.0).await?;
        for (id, params) in [(1, json!(["logs", filter])), (2, json!(["newHeads"]))] {
            let req = request(&mut socket).await?;
            assert_eq!(req["method"], "eth_subscribe");
            assert_eq!(req["params"], params);
            send(
                &mut socket,
                json!({"jsonrpc":"2.0", "id":id, "result":format!("0x{id}")}),
            )
            .await?;
        }
        for removed in [false, true] {
            notification(
                &mut socket,
                "0x1",
                Log {
                    block_number: Some(43.into()),
                    removed: Some(removed),
                    ..Default::default()
                },
            )
            .await?;
        }
        notification(
            &mut socket,
            "0x2",
            Block::<H256> {
                number: Some(42.into()),
                hash: Some(H256::repeat_byte(42)),
                parent_hash: H256::repeat_byte(41),
                ..Default::default()
            },
        )
        .await?;
        // No probe RPCs; a stalled subscription must close its transport.
        assert!(matches!(
            socket.next().await,
            None | Some(Err(_)) | Some(Ok(Message::Close(_)))
        ));
        Ok::<_, eyre::Report>(())
    };
    let client = async {
        let error = subscribe(&url, &filter, &wakeup, &wanted, &head_tx, &mut polled_rx, 1)
            .await
            .expect_err("stalled stream");
        tokio::time::resume();
        assert_eq!(
            error.to_string(),
            "Head subscription stalled behind polling"
        );
    };
    let observer = async {
        wakeup.notified().await;
        let header = head_rx.recv().await.expect("header");
        assert_eq!((header.height, header.parent), (42, H256::repeat_byte(41)));
        assert_eq!(wanted.load(Ordering::Relaxed), 43);
        tokio::time::pause();
        sleep(HEAD_STALL_TIMEOUT * 2).await; // A stationary chain must not time out.
        polled_tx.send_replace(44);
    };
    let (result, (), ()) = tokio::join!(server, client, observer);
    result
}

#[tokio::test]
async fn unanswered_subscriptions_close_the_socket() -> Result<()> {
    for pending in [1, 2] {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
        let wakeup = Notify::new();
        let wanted = AtomicU64::new(0);
        let (_polled_tx, mut polled_rx) = watch::channel(0);
        let (head_tx, _head_rx) = mpsc::channel(1);
        let server = async {
            let mut socket = accept_async(listener.accept().await?.0).await?;
            for id in 1..=2 {
                assert_eq!(request(&mut socket).await?["id"], id);
                if id < pending {
                    send(
                        &mut socket,
                        json!({"jsonrpc":"2.0", "id":id, "result":"0x1"}),
                    )
                    .await?;
                }
            }
            tokio::time::pause();
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

#[tokio::test]
async fn finalized_sealevel_account_filters_wake_and_recover_from_one_stalled_stream() -> Result<()>
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = Url::parse(&format!("ws://{}", listener.local_addr()?))?;
    let wakeup = Notify::new();
    let wanted = AtomicU64::new(0);
    let (polled_events, polled_rx) = watch::channel(Some([40; 3]));
    let server = async {
        let mut socket = accept_async(listener.accept().await?.0).await?;
        let mailbox = "11111111111111111111111111111111";
        let igp = "11111111111111111111111111111112";
        let mut expected = std::collections::HashMap::from([
            ("RElTUEFUQ0g=", (mailbox, 0)), // DISPATCH (also Merkle insertion)
            ("UFJPQ0VTU0Q=", (mailbox, 1)), // PROCESSD
            ("R0FTUEFZTVQ=", (igp, 2)),     // GASPAYMT
        ]);
        let mut subscriptions = [0; 3];
        for subscription in 1..=3 {
            let req = request(&mut socket).await?;
            assert_eq!(req["method"], "programSubscribe");
            let config = &req["params"][1];
            assert_eq!(config["commitment"], "finalized");
            assert_eq!(config["withContext"], true);
            assert_eq!(config["dataSlice"], json!({"offset": 0, "length": 0}));
            let filters = config["filters"].as_array().expect("filters");
            assert_eq!(filters.len(), 1);
            let memcmp = &filters[0]["memcmp"];
            assert_eq!(memcmp["offset"], 1);
            assert_eq!(memcmp["encoding"], "base64");
            let (owner, stream) = expected
                .remove(memcmp["bytes"].as_str().expect("discriminator"))
                .expect("unique discriminator");
            assert_eq!(req["params"][0].as_str(), Some(owner));
            subscriptions[stream] = subscription;
            send(
                &mut socket,
                json!({"jsonrpc":"2.0", "id":req["id"], "result":subscription}),
            )
            .await?;
        }
        wakeup.notified().await; // Initial catch-up after all filters are installed.
        for (slot, subscription) in
            (41..=44).zip(subscriptions.into_iter().chain([subscriptions[2]]))
        {
            if slot == 44 {
                tokio::time::pause();
                polled_events.send_replace(Some([41, 42, 43]));
                sleep(HEAD_STALL_TIMEOUT * 2 + Duration::from_millis(1)).await;
            }
            send(&mut socket, json!({
                "jsonrpc": "2.0", "method": "programNotification",
                "params": {"subscription":subscription, "result":{
                    "context":{"slot":slot}, "value":{"pubkey":mailbox, "account":{
                        "data":["","base64"], "owner":mailbox, "lamports":1, "executable":false, "rentEpoch":0
                    }}
                }}
            })).await?;
            wakeup.notified().await;
            assert_eq!(wanted.load(Ordering::Relaxed), slot);
        }
        // A new delivery was indexed without a notification. Keep the
        // connection open and the other subscriptions healthy.
        polled_events.send_replace(Some([41, 44, 44]));
        sleep(HEAD_STALL_TIMEOUT * 2).await;
        Ok::<_, eyre::Report>(())
    };
    let client = sealevel::subscribe_events(
        &url,
        hyperlane_core::H256::zero(),
        hyperlane_core::H256::from_low_u64_be(1),
        &wakeup,
        &wanted,
        polled_rx,
        1399811149,
    );
    let (server, client) = timeout(HEAD_STALL_TIMEOUT * 5, async {
        tokio::join!(server, client)
    })
    .await?;
    server?;
    assert_eq!(
        client.expect_err("stalled delivery stream").to_string(),
        "Sealevel event subscription stalled behind polling"
    );
    Ok(())
}
