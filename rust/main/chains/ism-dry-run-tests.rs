// Shared RPC traversal regressions included by the EVM and Tron ISM unit suites.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use ethers::abi::{encode, Token};
use ethers::types::H160;
use serde_json::{json, Value};

#[derive(Clone)]
enum Node {
    Leaf,
    Routing(usize),
    Aggregation(Vec<usize>, u8),
}

struct RpcGraph {
    url: url::Url,
    visits: Arc<AtomicUsize>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl RpcGraph {
    fn new(nodes: Vec<Node>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let visits = Arc::new(AtomicUsize::new(0));
        let stop = stopped.clone();
        let count = visits.clone();
        let nodes = Arc::new(nodes);
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            while !stop.load(Ordering::Acquire) {
                let (socket, _) = listener.accept().unwrap();
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let nodes = nodes.clone();
                let count = count.clone();
                requests.push(thread::spawn(move || {
                    serve_rpc_request(socket, &nodes, &count);
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        Self {
            url: format!("http://{address}").parse().unwrap(),
            visits,
            stopped,
            worker: Some(worker),
        }
    }
}

fn serve_rpc_request(mut socket: TcpStream, nodes: &[Node], count: &AtomicUsize) {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut request = Vec::new();
    let mut chunk = [0; 4096];
    let (header_end, content_length) = loop {
        let length = socket.read(&mut chunk).unwrap();
        if length == 0 {
            return;
        }
        request.extend_from_slice(&chunk[..length]);
        if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            break (end + 4, length);
        }
    };
    while request.len() < header_end + content_length {
        let length = socket.read(&mut chunk).unwrap();
        if length == 0 {
            return;
        }
        request.extend_from_slice(&chunk[..length]);
    }
    let body: Value = serde_json::from_slice(&request[header_end..]).unwrap();
    let ethereum = body.get("method").is_some();
    let estimate = if ethereum {
        body["method"] == "eth_estimateGas"
    } else {
        String::from_utf8_lossy(&request[..header_end]).contains("estimateenergy")
    };
    let result = if estimate {
        if ethereum {
            json!("0x7b")
        } else {
            json!({"energy_required": 123})
        }
    } else {
        let (address, data) = if ethereum {
            (&body["params"][0]["to"], &body["params"][0]["data"])
        } else {
            (&body["contract_address"], &body["data"])
        };
        let address = address.as_str().unwrap();
        let index = usize::from_str_radix(&address[address.len() - 8..], 16).unwrap();
        let data = data.as_str().unwrap().trim_start_matches("0x");
        let node = &nodes[index - 1];
        let tokens = match &data[..8] {
            "f7e83aee" => {
                count.fetch_add(1, Ordering::AcqRel);
                vec![Token::Bool(matches!(node, Node::Leaf))]
            }
            "6465e69f" => vec![Token::Uint(match node {
                Node::Leaf => 5.into(),
                Node::Routing(_) => 1.into(),
                Node::Aggregation(_, _) => 2.into(),
            })],
            selector => match node {
                Node::Routing(target) => {
                    assert_eq!(
                        selector,
                        hex::encode(&ethers::utils::id("route(bytes)")[..4])
                    );
                    vec![Token::Address(H160::from_low_u64_be(*target as u64))]
                }
                Node::Aggregation(children, threshold) => {
                    assert_eq!(
                        selector,
                        hex::encode(&ethers::utils::id("modulesAndThreshold(bytes)")[..4])
                    );
                    vec![
                        Token::Array(
                            children
                                .iter()
                                .map(|child| Token::Address(H160::from_low_u64_be(*child as u64)))
                                .collect(),
                        ),
                        Token::Uint((*threshold).into()),
                    ]
                }
                Node::Leaf => panic!("unexpected leaf call"),
            },
        };
        let encoded = hex::encode(encode(&tokens));
        if ethereum {
            json!(format!("0x{encoded}"))
        } else {
            json!({"constant_result": [encoded]})
        }
    };
    let response = if ethereum {
        json!({"jsonrpc":"2.0", "id":body["id"], "result":result})
    } else {
        result
    };
    let response = response.to_string();
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
}

impl Drop for RpcGraph {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        TcpStream::connect(self.url.socket_addrs(|| None).unwrap()[0]).unwrap();
        self.worker.take().unwrap().join().unwrap();
    }
}

fn graph_metadata(nodes: &[Node], index: usize) -> Metadata {
    let Node::Aggregation(children, _) = &nodes[index - 1] else {
        return Metadata::new(vec![1]);
    };
    let mut bytes = vec![0; children.len() * 8];
    for (index, child) in children.iter().enumerate() {
        let start = bytes.len() as u32;
        bytes.extend_from_slice(graph_metadata(nodes, *child).as_ref());
        let end = bytes.len() as u32;
        bytes[index * 8..index * 8 + 4].copy_from_slice(&start.to_be_bytes());
        bytes[index * 8 + 4..index * 8 + 8].copy_from_slice(&end.to_be_bytes());
    }
    Metadata::new(bytes)
}

#[tokio::test]
async fn dry_run_rpc_node_budget_boundaries() {
    for (children, accepted, visits) in [
        (98, true, 99),
        (99, true, 100),
        (100, false, 100),
        (101, false, 1),
    ] {
        let nodes = vec![
            Node::Aggregation(vec![2; children], children as u8),
            Node::Leaf,
        ];
        let metadata = graph_metadata(&nodes, 1);
        let rpc = RpcGraph::new(nodes);
        let ism = make_test_ism(rpc.url.clone());
        assert_eq!(
            ism.dry_run_verify(&HyperlaneMessage::default(), &metadata)
                .await
                .unwrap()
                .is_some(),
            accepted,
            "visits={} children={children}",
            rpc.visits.load(Ordering::Acquire)
        );
        assert_eq!(rpc.visits.load(Ordering::Acquire), visits);
    }
}

#[tokio::test]
async fn dry_run_rpc_shared_branches_share_budget() {
    for (children, accepted, visits) in [(48, true, 99), (49, false, 100)] {
        let nodes = vec![
            Node::Aggregation(vec![2, 3], 2),
            Node::Aggregation(vec![4; children], children as u8),
            Node::Aggregation(vec![4; children], children as u8),
            Node::Leaf,
        ];
        let metadata = graph_metadata(&nodes, 1);
        let rpc = RpcGraph::new(nodes);
        assert_eq!(
            make_test_ism(rpc.url.clone())
                .dry_run_verify(&HyperlaneMessage::default(), &metadata)
                .await
                .unwrap()
                .is_some(),
            accepted,
            "visits={} children={children}",
            rpc.visits.load(Ordering::Acquire)
        );
        assert_eq!(rpc.visits.load(Ordering::Acquire), visits);
    }
}

#[tokio::test]
async fn dry_run_rpc_cycles_and_exhaustion_stop_before_more_calls() {
    let rpc = RpcGraph::new(vec![Node::Routing(1)]);
    let ism = make_test_ism(rpc.url.clone());
    let message = HyperlaneMessage::default();
    let metadata = Metadata::new(vec![1]);
    assert!(ism
        .dry_run_verify(&message, &metadata)
        .await
        .unwrap()
        .is_none());
    assert_eq!(rpc.visits.load(Ordering::Acquire), MAX_ISM_DEPTH);
    let exhausted = AtomicUsize::new(0);
    assert!(ism
        .dry_run_verify_inner(&message, &metadata, MAX_ISM_DEPTH, &exhausted)
        .await
        .unwrap()
        .is_none());
    let untouched = AtomicUsize::new(MAX_ISM_NODES);
    assert!(ism
        .dry_run_verify_inner(&message, &metadata, 0, &untouched)
        .await
        .unwrap()
        .is_none());
    assert_eq!(untouched.load(Ordering::Acquire), MAX_ISM_NODES);
    assert_eq!(rpc.visits.load(Ordering::Acquire), MAX_ISM_DEPTH);
}
