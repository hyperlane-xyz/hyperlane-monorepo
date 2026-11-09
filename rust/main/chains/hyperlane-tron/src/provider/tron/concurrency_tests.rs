use ethers::types::TransactionRequest;
use hyperlane_core::{HyperlaneMessage, Mailbox, Metadata, TxCostEstimate};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    time::timeout,
};

use super::*;
use crate::TronMailbox;

struct Request {
    socket: BufReader<TcpStream>,
    path: String,
    body: Value,
}

async fn read_request(listener: &TcpListener) -> Request {
    let (socket, _) = listener.accept().await.expect("request");
    let mut socket = BufReader::new(socket);
    let mut line = String::new();
    socket.read_line(&mut line).await.expect("request line");
    let path = line
        .split_whitespace()
        .nth(1)
        .expect("request path")
        .to_owned();
    let mut content_length = 0;
    loop {
        line.clear();
        assert!(socket.read_line(&mut line).await.expect("header") > 0);
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().expect("request length");
            }
        }
    }
    let mut body = vec![0; content_length];
    socket.read_exact(&mut body).await.expect("request body");
    Request {
        socket,
        path,
        body: serde_json::from_slice(&body).expect("JSON body"),
    }
}

async fn respond(mut request: Request, body: Value) {
    let body = body.to_string();
    request
        .socket
        .get_mut()
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .expect("response");
}

// Withhold both responses until both requests arrive. Sequential code cannot
// complete this exchange; the timeout is a deadlock guard, not a timing target.
async fn serve_costs(listener: &TcpListener, estimate: bool) {
    let mut requests = vec![read_request(listener).await];
    if estimate {
        requests.push(read_request(listener).await);
    }
    let mut paths: Vec<_> = requests
        .iter()
        .map(|request| request.path.as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        if estimate {
            vec!["/jsonrpc", "/wallet/estimateenergy"]
        } else {
            vec!["/jsonrpc"]
        }
    );
    for request in requests {
        let body = if request.path == "/jsonrpc" {
            assert_eq!(request.body["method"], "eth_gasPrice");
            json!({"jsonrpc": "2.0", "id": request.body["id"], "result": "0x5"})
        } else {
            json!({"energy_required": 100})
        };
        respond(request, body).await;
    }
}

fn provider(listener: &TcpListener, signer: Option<TronSigner>) -> TronProvider {
    let address = listener.local_addr().expect("server address");
    let conf = ConnectionConf::new(
        vec![format!("http://{address}/jsonrpc")
            .parse()
            .expect("RPC URL")],
        vec![format!("http://{address}/wallet")
            .parse()
            .expect("wallet URL")],
        vec![format!("http://{address}/walletsolidity")
            .parse()
            .expect("solidified URL")],
        None,
    );
    let domain = HyperlaneDomain::new_test_domain("tron-concurrency");
    let locator = ContractLocator::new(&domain, H256::from_low_u64_be(1));
    TronProvider::new(&conf, &locator, signer, Default::default(), None).expect("provider")
}

#[tokio::test]
async fn mailbox_estimates_energy_and_price_concurrently() {
    timeout(Duration::from_secs(2), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let provider = provider(&listener, None);
        let domain = HyperlaneDomain::new_test_domain("tron-concurrency");
        let locator = ContractLocator::new(&domain, H256::from_low_u64_be(1));
        let mailbox = TronMailbox::new(provider, &locator);
        let message = HyperlaneMessage::default();
        let metadata = Metadata::new(Vec::new());
        let (estimate, ()) = tokio::join!(
            mailbox.process_estimate_costs(&message, &metadata),
            serve_costs(&listener, true),
        );
        assert_eq!(
            estimate.expect("cost estimate"),
            TxCostEstimate {
                gas_limit: U256::from(100),
                gas_price: U256::from(5).try_into().expect("gas price"),
                l2_gas_limit: None,
            }
        );
    })
    .await
    .expect("independent energy and price reads must overlap");
}

async fn submit_and_verify_fee(supplied_gas: Option<u64>) {
    timeout(Duration::from_secs(2), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let signer = ethers_signers::LocalWallet::new(&mut ethers::core::rand::thread_rng());
        let provider = provider(&listener, Some(signer.into()));
        let mut request = TransactionRequest::new().to(H160::from_low_u64_be(1));
        if let Some(gas) = supplied_gas {
            request = request.gas(gas);
        }
        let tx: TypedTransaction = request.into();
        let server = async {
            serve_costs(&listener, supplied_gas.is_none()).await;
            // A fresh signing reference is fetched only after both cost reads.
            let block_request = read_request(&listener).await;
            assert_eq!(block_request.path, "/walletsolidity/getnowblock");
            respond(block_request, json!({
                "blockID": "00".repeat(32),
                "block_header": {"raw_data": {"number": 123, "timestamp": 1_700_000_000_000_i64}},
            })).await;
            let broadcast = read_request(&listener).await;
            assert_eq!(broadcast.path, "/wallet/broadcasthex");
            let encoded = hex::decode(
                broadcast.body["transaction"]
                    .as_str()
                    .expect("hex transaction"),
            )
            .expect("transaction bytes");
            let signed = Transaction::decode(encoded.as_slice()).expect("Tron transaction");
            assert_eq!(signed.signature.len(), 1);
            let raw = signed.raw_data.expect("raw transaction");
            assert_eq!(
                raw.fee_limit,
                if supplied_gas.is_some() { 1500 } else { 750 }
            );
            assert_eq!(raw.ref_block_bytes, calculate_ref_block_bytes(123));
            let expected_hash = calculate_txid(&raw);
            respond(broadcast, json!({"result": true})).await;
            expected_hash
        };
        let (hash, expected_hash) = tokio::join!(provider.submit_tx(&tx), server);
        assert_eq!(hash.expect("submitted transaction"), expected_hash);
    })
    .await
    .expect("cost reads must overlap and signing must follow them");
}

#[tokio::test]
async fn submission_overlaps_cost_reads_before_fetching_a_fresh_signing_reference() {
    submit_and_verify_fee(None).await;
}

#[tokio::test]
async fn submission_with_supplied_gas_skips_estimation_and_preserves_fee_limit() {
    submit_and_verify_fee(Some(200)).await;
}
