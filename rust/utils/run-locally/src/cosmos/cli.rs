use std::str::FromStr;
use std::{
    collections::BTreeMap, io::Write, path::PathBuf, process::Stdio, thread::sleep, time::Duration,
};

use cosmrs::tendermint::Hash;
use hyperlane_cosmos::{payloads::general::Event, RawCosmosAmount};

use cosmrs::rpc::endpoint::abci_query;
use cosmrs::rpc::endpoint::broadcast;
use cosmrs::rpc::endpoint::tx;
use cosmrs::rpc::HttpClient;
use k256::ecdsa::SigningKey;
use tendermint_rpc::endpoint::tx::DialectResponse;
use tendermint_rpc::Client;
use tokio::runtime::Handle;
use tokio::task::block_in_place;

use crate::{
    cosmos::types::{CodeId, CodeInfos},
    program::Program,
    utils::{concat_path, AgentHandles, TaskHandle},
};

use super::{
    crypto::KeyPair, default_keys, modify_toml, sed, types::BalanceResponse, wait_for_node, Codes,
    TxResponse,
};

// #[derive(serde::Serialize, serde::Deserialize, Debug)]
// struct TxQueryResponse(Response);

const GENESIS_FUND: u128 = 1000000000000000000000;

#[derive(Clone)]
pub struct InjectiveEndpoint {
    pub addr: String,
    pub rpc_addr: String,
    pub grpc_addr: String,
}

impl InjectiveEndpoint {
    fn wait_for_node(&self) {
        wait_for_node(&self.rpc_addr)
    }

    fn add_rpc(&self, program: Program) -> Program {
        program.arg("node", &self.rpc_addr)
    }
}

pub struct InjectiveCLI {
    pub bin: PathBuf,
    pub home: String,
}

#[allow(dead_code)]
impl InjectiveCLI {
    pub fn new(bin: PathBuf, home: &str) -> Self {
        Self {
            bin,
            home: home.to_string(),
        }
    }

    fn cli(&self) -> Program {
        Program::new(self.bin.clone()).arg("home", &self.home)
    }

    fn add_gas(&self, program: Program) -> Program {
        program
            .arg("gas", "auto")
            .arg("gas-prices", "1inj")
            .arg("gas-adjustment", "1.5")
            .flag("yes")
    }

    pub fn init(&self, moniker: &str, chain_id: &str) {
        self.cli()
            .cmd("init")
            .cmd(moniker)
            .arg("chain-id", chain_id)
            .run()
            .join();

        let genesis_path = concat_path(&self.home, "config/genesis.json");
        // cat the content of the genesis json file:
        sed("ustake", "inj", genesis_path.to_str().unwrap());
        sed("\"stake\"", "\"inj\"", genesis_path.to_str().unwrap());
        // Program::new("cat")
        //     .cmd(genesis_path.to_str().unwrap())
        //     .run()
        //     .join();

        // modify node config
        let node_config_path = concat_path(&self.home, "config/config.toml");
        // modify_toml(
        //     node_config_path,
        //     Box::new(|v| {
        //         v["p2p"]["pex"] = toml_edit::value(false);
        //         v["consensus"]["timeout_commit"] = toml_edit::value("0.5s");
        //     }),
        // );

        // modify client config
        let client_chain_id = chain_id.to_string();
        let client_config_path = concat_path(&self.home, "config/client.toml");
        modify_toml(
            client_config_path,
            Box::new(move |v| {
                v["keyring-backend"] = toml_edit::value("test");
                v["output"] = toml_edit::value("json");
                v["chain-id"] = toml_edit::value(client_chain_id.clone());
            }),
        );

        self.add_default_keys();
        self.add_genesis_accs(chain_id);

        self.cli()
            .cmd("gentx")
            .cmd("validator")
            .cmd(format!("{}inj", GENESIS_FUND))
            .arg("chain-id", chain_id)
            .arg("keyring-backend", "test")
            .run()
            .join();

        self.cli().cmd("collect-gentxs").run().join();
    }

    pub fn start(&self, addr_base: String, port_base: u32) -> (AgentHandles, InjectiveEndpoint) {
        if !addr_base.starts_with("tcp://") {
            panic!("invalid addr_base: {}", addr_base);
        }

        let mut next_port = port_base;
        let mut get_next_addr = || {
            let port = next_port;
            next_port += 1;
            format!("{addr_base}:{port}")
        };

        let addr = get_next_addr();
        let p2p_addr = get_next_addr();
        let rpc_addr = get_next_addr();
        let api_addr = get_next_addr();
        let grpc_addr = get_next_addr().replace("tcp://", "");
        let grpc_web_addr = get_next_addr().replace("tcp://", "");
        let pprof_addr = get_next_addr().replace("tcp://", "");

        let endpoint = InjectiveEndpoint {
            addr,
            rpc_addr,
            grpc_addr,
        };

        // modify app config
        let app_config_path = concat_path(&self.home, "config/app.toml");
        modify_toml(
            app_config_path,
            Box::new(move |v| {
                v["minimum-gas-prices"] = toml_edit::value("1inj");
                v["pruning"] = toml_edit::value("nothing"); // archive
                v["api"]["enable"] = toml_edit::value(true);
                // v["api"]["address"] = toml_edit::value(api_addr.clone());
                // v["grpc-web"]["enable"] = toml_edit::value(false);
            }),
        );
        println!("~~~ rpc addr: {}", endpoint.rpc_addr);

        let node = self
            .cli()
            .cmd("start")
            .arg("address", &endpoint.addr) // default is tcp://0.0.0.0:26658
            // addrs
            .arg("p2p.laddr", p2p_addr) // default is tcp://0.0.0.0:26655
            .arg("rpc.laddr", &endpoint.rpc_addr) // default is tcp://0.0.0.0:26657
            .arg("grpc.address", &endpoint.grpc_addr) // default is 0.0.0.0:9090
            .arg("grpc-web.address", grpc_web_addr) // default is 0.0.0.0:9090
            .arg("rpc.pprof_laddr", pprof_addr) // default is localhost:6060
            .arg("log-level", "debug")
            .flag("trace")
            .spawn("COSMOS");

        endpoint.wait_for_node();

        (node, endpoint)
    }

    pub async fn store_codes(
        &self,
        endpoint: &InjectiveEndpoint,
        sender: &str,
        codes: BTreeMap<String, PathBuf>,
    ) -> Codes {
        let mut ret = BTreeMap::<String, u64>::new();

        for (name, code) in codes {
            let cmd = self
                .cli()
                .cmd("tx")
                .cmd("wasm")
                .cmd("store")
                .cmd(code.to_str().unwrap())
                .arg("from", sender);

            let cmd = self.add_gas(cmd);
            let cmd = endpoint.add_rpc(cmd);

            let raw_output = cmd.run_with_output().join();
            let wasm_store_tx_resp: TxResponse =
                serde_json::from_str(raw_output.first().unwrap()).unwrap();
            println!("wasm_store_tx_resp: {:?}", wasm_store_tx_resp);
            sleep(Duration::from_secs(2));

            let rpc_address = format!("http://localhost:{}", 26602);
            let rpc_client = HttpClient::new(rpc_address.as_str()).unwrap();
            let tx_hash = wasm_store_tx_resp.txhash;

            let tx = rpc_client
                .tx(Hash::from_str(&tx_hash).unwrap(), false)
                .await
                .unwrap();
            println!("~~~ queried tx events: {:?}", tx.tx_result.events);

            let code_id_attr = tx
                .tx_result
                .events
                .iter()
                .flat_map(|event| event.attributes.iter())
                .find(|&attr| attr.key == "code_id")
                .unwrap();
            let raw_event_id = code_id_attr.value.clone();
            let event_id: String = raw_event_id
                .chars()
                .filter(|&c| c != '\\' && c != '\"')
                .collect();

            // let code_id = &store_code_evt.attributes.last().unwrap().value;
            // let code_id = code_id.parse::<u64>().unwrap();
            println!("~~~ found event id: {:?}", event_id);
            ret.insert(name, event_id.parse().unwrap());
        }
        serde_json::from_str(&serde_json::to_string(&ret).unwrap()).unwrap()
    }

    pub async fn wasm_init<T: serde::ser::Serialize>(
        &self,
        endpoint: &InjectiveEndpoint,
        sender: &str,
        admin: Option<&str>,
        code_id: u64,
        init_msg: T,
        label: &str,
    ) -> String {
        let mut cmd = self
            .cli()
            .cmd("tx")
            .cmd("wasm")
            .cmd("instantiate")
            .cmd(code_id.to_string())
            .cmd(serde_json::to_string(&init_msg).unwrap())
            .arg("from", sender)
            .arg("label", label);

        cmd = self.add_gas(cmd);
        cmd = endpoint.add_rpc(cmd);

        if let Some(admin) = admin {
            cmd = cmd.arg("admin", admin);
        } else {
            cmd = cmd.flag("no-admin");
        }

        let wasm_init_resp: TxResponse =
            serde_json::from_str(cmd.run_with_output().join().first().unwrap()).unwrap();

        println!("wasm_store_tx_resp: {:?}", wasm_init_resp);
        sleep(Duration::from_secs(2));

        let rpc_address = format!("http://localhost:{}", 26602);
        let rpc_client = HttpClient::new(rpc_address.as_str()).unwrap();
        let tx_hash = wasm_init_resp.txhash;

        let tx = rpc_client
            .tx(Hash::from_str(&tx_hash).unwrap(), false)
            .await
            .unwrap();
        println!("~~~ queried tx events: {:?}", tx.tx_result.events);

        let contract_addr = tx
            .tx_result
            .events
            .iter()
            .flat_map(|event| event.attributes.iter())
            .find(|&attr| attr.key == "_contract_address")
            .unwrap()
            .value
            .clone();
        println!("~~~ found instiantiated contract addr: {:?}", contract_addr);
        contract_addr
    }

    pub fn wasm_execute<T: serde::ser::Serialize>(
        &self,
        endpoint: &InjectiveEndpoint,
        sender: &str,
        contract: &str,
        execute_msg: T,
        funds: Vec<RawCosmosAmount>,
    ) -> TxResponse {
        let mut cmd = self
            .cli()
            .cmd("tx")
            .cmd("wasm")
            .cmd("execute")
            .cmd(contract)
            .cmd(serde_json::to_string(&execute_msg).unwrap())
            .arg("from", sender);

        cmd = self.add_gas(cmd);
        cmd = endpoint.add_rpc(cmd);

        if !funds.is_empty() {
            cmd = cmd.arg(
                "amount",
                funds
                    .into_iter()
                    .map(|v| format!("{}{}", v.amount, v.denom))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }

        let run_result = cmd.run_with_output().join();

        println!("wasm execute res: {:?}", run_result);

        let output: Result<TxResponse, serde_json::Error> =
            serde_json::from_str(run_result.first().unwrap());

        output.unwrap()
    }

    pub fn wasm_query<T: serde::ser::Serialize>(
        // U: serde::de::DeserializeOwned>(
        &self,
        endpoint: &InjectiveEndpoint,
        contract: &str,
        query_msg: T,
    ) {
        let mut cmd = self
            .cli()
            .cmd("query")
            .cmd("wasm")
            .cmd("contract-state")
            .cmd("smart")
            .cmd(contract)
            .cmd(serde_json::to_string(&query_msg).unwrap());

        cmd = endpoint.add_rpc(cmd);

        let output = cmd.run_with_output().join();
        let output = output.first().unwrap();

        println!("output: {:?}", output);
        // let output: CliWasmQueryResponse<U> = serde_json::from_str(output).unwrap();

        // output.data
    }

    pub fn query_balance(&self, endpoint: &InjectiveEndpoint, addr: &str) -> BalanceResponse {
        let cmd = endpoint
            .add_rpc(self.cli())
            .cmd("query")
            .cmd("bank")
            .cmd("balances")
            .cmd(addr)
            .run_with_output()
            .join();

        let output = serde_json::from_str(cmd.first().unwrap()).unwrap();

        output
    }

    pub fn bank_send(
        &self,
        endpoint: &InjectiveEndpoint,
        sender: &str,
        sender_addr: &str,
        addr: &str,
        funds: &str,
    ) {
        let mut cmd = self
            .cli()
            .cmd("tx")
            .cmd("bank")
            .cmd("send")
            .cmd(sender_addr)
            .cmd(addr)
            .cmd(funds)
            .arg("from", sender);

        cmd = self.add_gas(cmd);
        cmd = endpoint.add_rpc(cmd);

        cmd.run().join();
    }

    fn add_genesis_accs(&self, chain_id: &str) {
        for name in default_keys().into_iter().map(|(name, _)| name) {
            self.cli()
                .cmd("add-genesis-account")
                .arg("chain-id", chain_id)
                .cmd(self.get_addr(name))
                .cmd(format!("{}inj", GENESIS_FUND * 2))
                .run()
                .join();
        }
    }

    fn add_default_keys(&self) {
        for (name, mnemonic) in default_keys() {
            self.add_key(name, mnemonic);
        }
    }

    pub fn add_key(&self, name: &str, mnemonic: &str) {
        let mut child = self
            .cli()
            .cmd("keys")
            .cmd("add")
            .cmd(name)
            .flag("recover")
            .create_command()
            .stdin(Stdio::piped())
            .spawn()
            .expect("failed to spawn process");

        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("{mnemonic}\n").as_bytes())
            .unwrap();

        child.wait().unwrap();
    }

    pub fn get_addr(&self, name: &str) -> String {
        let out = self
            .cli()
            .cmd("keys")
            .cmd("show")
            .raw_arg("-a")
            .cmd(name)
            .run_with_output()
            .join();
        out.first().unwrap().clone()
    }

    pub fn get_keypair(&self, name: &str) -> KeyPair {
        let cmd = self
            .cli()
            .cmd("keys")
            .cmd("export")
            .cmd(name)
            .flag("unarmored-hex")
            .flag("unsafe");

        let mut proc = cmd
            .create_command()
            .stderr(Stdio::piped())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();

        proc.stdin.as_mut().unwrap().write_all(b"y\n").unwrap();
        let proc_output = proc.wait_with_output().unwrap();
        let proc_output_str = String::from_utf8_lossy(&proc_output.stderr).to_string();

        let priv_key =
            SigningKey::from_slice(&hex::decode(proc_output_str.trim()).unwrap()).unwrap();
        let pub_key = *priv_key.verifying_key();

        KeyPair { priv_key, pub_key }
    }
}
