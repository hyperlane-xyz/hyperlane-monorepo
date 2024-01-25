use std::{thread::sleep, time::Duration};

use ureq::get;

const MAX_REQUEST_COUNT: i32 = 30;

#[derive(serde::Serialize, serde::Deserialize)]
struct JsonRpcResp {
    pub jsonrpc: String,
    pub id: i32,
    pub result: serde_json::Value,
}

pub fn wait_for_node(rpc_addr: &str) {
    let mut count = 0;
    loop {
        if count > MAX_REQUEST_COUNT {
            panic!("failed to start node");
        }

        let req_url = format!("{}/status", rpc_addr.replace("tcp", "http"));
        if let Ok(resp) = get(&req_url).call() {
            if resp.status() == 200 {
                let rpc_resp: JsonRpcResp =
                    serde_json::from_str(&resp.into_string().unwrap()).unwrap();

                let rpc_resp = rpc_resp.result.as_object().unwrap();
                let rpc_resp = rpc_resp["sync_info"].as_object().unwrap();

                let latest_block_height = rpc_resp["latest_block_height"].as_str().unwrap();
                let latest_block_height = latest_block_height.parse::<u64>().unwrap();

                if latest_block_height > 0 {
                    break;
                }
            }
        }

        sleep(Duration::from_secs(1));
        count += 1;
    }
}
