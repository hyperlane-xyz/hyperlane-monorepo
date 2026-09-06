use std::{
    thread::sleep,
    time::{Duration, Instant},
};

use crate::{
    log,
    program::Program,
    utils::{AgentHandles, TaskHandle},
};

const TX_MAX_RETRIES: u32 = 5;
const TX_RETRY_DELAY: Duration = Duration::from_secs(3);

fn transaction_confirmed(body: &str) -> bool {
    let response: serde_json::Value =
        serde_json::from_str(body).expect("Invalid transaction query response");
    if let Some(error) = response.get("error") {
        assert!(
            error["data"]
                .as_str()
                .is_some_and(|data| data.contains("not found")),
            "Transaction query failed: {error}"
        );
        return false;
    }
    let result = &response["result"];
    assert!(
        result["height"]
            .as_str()
            .and_then(|height| height.parse::<u64>().ok())
            .is_some_and(|height| height > 0),
        "Missing committed transaction height: {response}"
    );
    assert_eq!(
        result["tx_result"]["code"].as_u64(),
        Some(0),
        "Transaction execution failed: {response}"
    );
    true
}

use super::{
    constants::{CHAIN_ID, DENOM, KEY_CHAIN_VALIDATOR},
    types::Contracts,
};

const GENESIS_FUND: u128 = 1000000000000;
const IGP_ADDRESS: &str = "0x726f757465725f706f73745f6469737061746368000000040000000000000000";
const MERKLE_ISM_ADDRESS: &str =
    "0x726f757465725f69736d00000000000000000000000000040000000000000000";
const ROUTING_ISM_ADDRESS: &str =
    "0x726f757465725f69736d00000000000000000000000000010000000000000001";
const MAILBOX_ADDRESS: &str = "0x68797065726c616e650000000000000000000000000000000000000000000000";
const MERKLE_TREE_HOOK_ADDRESS: &str =
    "0x726f757465725f706f73745f6469737061746368000000030000000000000001";
const COLLATERAL_TOKEN_ADDRESS: &str =
    "0x726f757465725f61707000000000000000000000000000010000000000000000";
const SYNTHETIC_TOKEN_ADDRESS: &str =
    "0x726f757465725f61707000000000000000000000000000020000000000000001";

#[derive(Debug)]
pub struct SimApp {
    pub(crate) bin: String,
    pub(crate) home: String,
    pub(crate) addr: String,
    pub(crate) p2p_addr: String,
    pub(crate) rpc_addr: String,
    pub(crate) grpc_addr: String,
    pub(crate) pprof_addr: String,
    pub(crate) api_addr: String,
}

/// Sim app
///
/// the sim app is a light cosmos chain that implements the hyperlane cosmos module
impl SimApp {
    pub fn new(bin: String, home: String, port_offset: u32) -> Self {
        let port_base = 26657 + port_offset * 6; // we increment by 6 ports as we need 6 unique ports per chain
        let addr_base = "tcp://127.0.0.1";

        let mut next_port = port_base;
        let mut get_next_addr = || {
            let port = next_port;
            next_port += 1;
            format!("{addr_base}:{port}")
        };

        let addr = get_next_addr();
        let p2p_addr = get_next_addr();
        let rpc_addr = get_next_addr();
        let grpc_addr = get_next_addr().replace("tcp://", "");
        // this is not necessary for the agents, however, it is really nice to have access to the rest queries for debug purposes
        let api_addr = get_next_addr();
        let pprof_addr = get_next_addr().replace("tcp://", "");

        return SimApp {
            bin,
            home,
            addr,
            rpc_addr,
            p2p_addr,
            pprof_addr,
            grpc_addr,
            api_addr,
        };
    }

    fn cli(&self) -> Program {
        Program::new(self.bin.clone()).arg("home", self.home.clone())
    }

    pub fn init(&self) {
        self.cli().cmd("init-sample-chain").run().join();

        // Speed up block times for faster E2E tests
        let config_path = format!("{}/config/config.toml", self.home);
        let contents =
            std::fs::read_to_string(&config_path).expect("Failed to read config.toml after init");
        let mut doc = contents
            .parse::<toml_edit::Document>()
            .expect("Failed to parse config.toml");
        doc["consensus"]["timeout_commit"] = toml_edit::value("1s");
        std::fs::write(&config_path, doc.to_string()).expect("Failed to write config.toml");
    }

    pub fn start(&mut self) -> AgentHandles {
        let node = self
            .cli()
            .cmd("start")
            .arg("address", &self.addr) // default is tcp://0.0.0.0:26658
            .arg("p2p.laddr", &self.p2p_addr) // default is tcp://0.0.0.0:26655
            .arg("rpc.laddr", &self.rpc_addr) // default is tcp://0.0.0.0:26657
            .flag("grpc.enable=true") // enable grpc
            .flag("api.enable") // enable api
            .arg("api.address", &self.api_addr)
            .arg("grpc.address", &self.grpc_addr)
            .arg("rpc.pprof_laddr", &self.pprof_addr) // default is localhost:6060
            .arg("log_level", "panic")
            .spawn("SIMAPP", None);
        self.wait_for_node();
        node
    }

    /// Poll the CometBFT RPC /status endpoint until the node is producing blocks.
    fn wait_for_node(&self) {
        use ureq::get;
        const MAX_ATTEMPTS: u32 = 30;
        let url = format!("{}/status", self.rpc_addr.replace("tcp", "http"));
        for attempt in 1..=MAX_ATTEMPTS {
            if let Ok(resp) = get(&url).call() {
                if resp.status() == 200 {
                    if let Ok(body) = resp.into_string() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let Some(height) =
                                json["result"]["sync_info"]["latest_block_height"].as_str()
                            {
                                if height.parse::<u64>().unwrap_or(0) > 0 {
                                    log!("SimApp node ready after {} attempts", attempt);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            sleep(Duration::from_secs(1));
        }
        panic!("SimApp node not ready after {MAX_ATTEMPTS} attempts");
    }

    /// Run a transaction program with retries, panicking if all attempts fail.
    fn run_tx_with_retry(&self, program: &Program) {
        for attempt in 1..=TX_MAX_RETRIES {
            let (success, output) = program
                .clone()
                .arg("output", "json")
                .arg("broadcast-mode", "sync")
                .run_with_status_and_output()
                .join();
            if success {
                let response: serde_json::Value = serde_json::from_str(&output.join("\n"))
                    .expect("Invalid transaction broadcast response");
                assert_eq!(
                    response["code"].as_u64(),
                    Some(0),
                    "Transaction rejected: {response}"
                );
                let hash = response["txhash"]
                    .as_str()
                    .expect("Missing transaction hash");
                assert!(
                    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                    "Invalid transaction hash: {hash}"
                );
                self.wait_for_transaction(hash);
                return;
            }
            if attempt < TX_MAX_RETRIES {
                log!(
                    "Transaction failed (attempt {}/{}), retrying in {}s...",
                    attempt,
                    TX_MAX_RETRIES,
                    TX_RETRY_DELAY.as_secs()
                );
                sleep(TX_RETRY_DELAY);
            }
        }
        panic!(
            "Transaction failed after {} attempts: {:?}",
            TX_MAX_RETRIES, program
        );
    }

    fn wait_for_transaction(&self, hash: &str) {
        let url = format!("{}/tx", self.rpc_addr.replace("tcp://", "http://"));
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let response = ureq::get(&url)
                .query("hash", &format!("0x{hash}"))
                .timeout(Duration::from_secs(2))
                .call();
            // CometBFT reports an unindexed transaction as a JSON-RPC error,
            // including on HTTP 500. Never rebroadcast an accepted transaction.
            match response {
                Ok(response) | Err(ureq::Error::Status(_, response)) => {
                    let body = response
                        .into_string()
                        .expect("Failed to read transaction response");
                    if transaction_confirmed(&body) {
                        return;
                    }
                }
                Err(error) => log!("Waiting for transaction {}: {}", hash, error),
            }
            sleep(Duration::from_millis(100));
        }
        panic!("Transaction {hash} was not confirmed within 30s");
    }

    fn tx<'a>(&self, args: Vec<&'a str>) {
        let mut program = Program::new(self.bin.clone()).cmd("tx");
        for arg in args {
            program = program.cmd(arg);
        }
        let program = program
            .arg("from", KEY_CHAIN_VALIDATOR.0)
            .arg("chain-id", CHAIN_ID)
            .arg("fees", format!("40000{}", DENOM))
            .arg("node", &self.rpc_addr)
            .arg("home", &self.home)
            .arg("keyring-backend", "test")
            .flag("yes");
        self.run_tx_with_retry(&program);
    }

    pub fn remote_transfer(
        &self,
        from: &str,
        token_id: &str,
        remote_domain: &str,
        recipient: &str,
        amount: u32,
    ) {
        let transfer = Program::new(self.bin.clone())
            .cmd("tx")
            .cmd("hyperlane-transfer")
            .cmd("transfer")
            .cmd(token_id)
            .cmd(remote_domain)
            .cmd(recipient)
            .cmd(&format!("{amount}"))
            .arg("gas-limit", "800000")
            .arg("max-hyperlane-fee", "1000000uhyp") // this is a sdk.Coin, it needs the denom
            .arg("from", from)
            .arg("chain-id", CHAIN_ID)
            .arg("fees", format!("80000{}", DENOM))
            .arg("node", &self.rpc_addr)
            .arg("home", &self.home)
            .arg("keyring-backend", "test")
            .arg("gas", "400000")
            .flag("yes");
        self.run_tx_with_retry(&transfer);
    }

    pub fn deploy_and_configure_contracts(
        &self,
        local_domain: &str,
        destination_domain: &str,
    ) -> Contracts {
        log!("deploying hyperlane for domain: {} ...", destination_domain);

        // TODO: parse tx response and get created ids from that

        // create interchain gas paymaster
        // the igp address expected to be: 0x726f757465725f706f73745f6469737061746368000000040000000000000000
        // TODO: test against the tx result to see if everything was created correctly
        self.tx(vec!["hyperlane", "hooks", "igp", "create", DENOM]);

        // set the interchain gas config -> this determines the interchain gaspayments
        // cmd is following: igp-address remote-domain exchange-rate gas-price and gas-overhead
        // this config requires a payment of at least 0.200001uhyp
        self.tx(vec![
            "hyperlane",
            "hooks",
            "igp",
            "set-destination-gas-config",
            IGP_ADDRESS,
            destination_domain,
            "10000000000", //1e10
            "1",
            "200000",
        ]);

        // create ism
        // cmd is following: validator-addresses threshold
        // expected ism address: 0x726f757465725f69736d00000000000000000000000000040000000000000000
        let address = "0xb05b6a0aa112b61a7aa16c19cac27d970692995e"; // TODO: convert KEY_VALIDATOR to eth address
        self.tx(vec![
            "hyperlane",
            "ism",
            "create-merkle-root-multisig",
            &address,
            "1",
        ]);

        // create routing ism and configure it to use the merkle tree ism just created
        // cmd is following: create-routing
        // expected ism address: 0x726f757465725f69736d00000000000000000000000000010000000000000001
        self.tx(vec!["hyperlane", "ism", "create-routing"]);

        // configure the routing ism to use the merkle tree ism
        // cmd is following: set-routing-ism-domain [routing-ism-id] [domain] [ism-id]
        self.tx(vec![
            "hyperlane",
            "ism",
            "set-routing-ism-domain",
            ROUTING_ISM_ADDRESS,
            destination_domain,
            MERKLE_ISM_ADDRESS,
        ]);

        // create mailbox
        // cmd is following: default-ism local-domain
        // expected mailbox address: 0x68797065726c616e650000000000000000000000000000000000000000000000
        self.tx(vec![
            "hyperlane",
            "mailbox",
            "create",
            ROUTING_ISM_ADDRESS,
            local_domain,
        ]);

        // create merkle_tree_hook
        // cmd is following: mailbox-address
        // expected merkle_tree_hook address: 0x726f757465725f706f73745f6469737061746368000000030000000000000001
        self.tx(vec![
            "hyperlane",
            "hooks",
            "merkle",
            "create",
            MAILBOX_ADDRESS,
        ]);

        // set mailbox to use the hooks
        // cmd is following: mailbox-id --required-hook [id] --default-hook [id]
        let mailbox_set = Program::new(self.bin.clone())
            .cmd("tx")
            .cmd("hyperlane")
            .cmd("mailbox")
            .cmd("set")
            .cmd(MAILBOX_ADDRESS)
            .arg("required-hook", MERKLE_TREE_HOOK_ADDRESS)
            .arg("default-hook", IGP_ADDRESS)
            .arg("from", KEY_CHAIN_VALIDATOR.0)
            .arg("chain-id", CHAIN_ID)
            .arg("fees", format!("80000{}", DENOM))
            .arg("node", &self.rpc_addr)
            .arg("home", &self.home)
            .arg("keyring-backend", "test")
            .flag("yes");
        self.run_tx_with_retry(&mailbox_set);

        // create warp route
        // expected address: 0x726f757465725f61707000000000000000000000000000010000000000000000
        self.tx(vec![
            "hyperlane-transfer",
            "create-collateral-token",
            MAILBOX_ADDRESS,
            DENOM,
        ]);

        // enroll the remote domain to this token
        // cmd is following: token-id receiver-domain receiver-contract gas
        self.tx(vec![
            "hyperlane-transfer",
            "enroll-remote-router",
            COLLATERAL_TOKEN_ADDRESS,
            destination_domain,
            SYNTHETIC_TOKEN_ADDRESS,
            "50000",
        ]);

        // create warp route
        // expected address: 0x726f757465725f61707000000000000000000000000000020000000000000001
        self.tx(vec![
            "hyperlane-transfer",
            "create-synthetic-token",
            MAILBOX_ADDRESS,
        ]);

        // enroll the remote domain to this token
        // cmd is following: token-id receiver-domain receiver-contract gas
        self.tx(vec![
            "hyperlane-transfer",
            "enroll-remote-router",
            SYNTHETIC_TOKEN_ADDRESS,
            destination_domain,
            COLLATERAL_TOKEN_ADDRESS,
            "50000",
        ]);

        Contracts {
            mailbox: MAILBOX_ADDRESS.to_owned(),
            merkle_tree_hook: MERKLE_TREE_HOOK_ADDRESS.to_owned(),
            igp: IGP_ADDRESS.to_owned(),
            tokens: vec![
                COLLATERAL_TOKEN_ADDRESS.to_owned(),
                SYNTHETIC_TOKEN_ADDRESS.to_owned(),
            ],
        }
    }
}

#[cfg(test)]
mod confirmation_tests {
    use super::transaction_confirmed;

    #[test]
    fn waits_for_indexing() {
        assert!(!transaction_confirmed(
            r#"{"error":{"data":"tx (ABC) not found"}}"#
        ));
    }

    #[test]
    fn accepts_committed_success() {
        assert!(transaction_confirmed(
            r#"{"result":{"height":"12","tx_result":{"code":0}}}"#
        ));
    }

    #[test]
    #[should_panic(expected = "Transaction execution failed")]
    fn rejects_failed_execution() {
        transaction_confirmed(r#"{"result":{"height":"12","tx_result":{"code":5}}}"#);
    }

    #[test]
    #[should_panic(expected = "Missing committed transaction height")]
    fn rejects_uncommitted_response() {
        transaction_confirmed(r#"{"result":{"height":"0","tx_result":{"code":0}}}"#);
    }

    #[test]
    #[should_panic(expected = "Transaction query failed")]
    fn rejects_other_rpc_errors() {
        transaction_confirmed(r#"{"error":{"data":"transaction indexing is disabled"}}"#);
    }

    #[test]
    #[should_panic(expected = "Invalid transaction query response")]
    fn rejects_malformed_json() {
        transaction_confirmed("not JSON");
    }
}
