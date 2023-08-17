use std::{collections::BTreeMap, io::Write, path::PathBuf, process::Stdio};

use crate::{
    program::Program,
    utils::{concat_path, AgentHandles, TaskHandle},
};

use super::{
    modify_toml, sed, wait_for_node, KEY_ACCOUNTS1, KEY_ACCOUNTS2, KEY_ACCOUNTS3, KEY_VALIDATOR,
    {Coin, TxResponse},
};

const GENESIS_FUND: u128 = 1000000000000;

pub struct OsmosisEndpoint {
    pub addr: String,
    pub rpc_addr: String,
    pub grpc_addr: String,
}

impl OsmosisEndpoint {
    fn wait_for_node(&self) {
        wait_for_node(&self.rpc_addr)
    }

    fn add_rpc(&self, program: Program) -> Program {
        program.arg("node", &self.rpc_addr)
    }
}

pub struct OsmosisCLI {
    pub bin: PathBuf,
    pub home: String,
}

impl OsmosisCLI {
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
            .arg("gas-prices", "0.025uosmo")
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
        sed("stake", "uosmo", genesis_path.to_str().unwrap());

        // modify node config
        let node_config_path = concat_path(&self.home, "config/config.toml");
        modify_toml(
            node_config_path,
            Box::new(|v| {
                v["p2p"]["pex"] = toml_edit::value(false);
                v["consensus"]["timeout_commit"] = toml_edit::value("1s");
            }),
        );

        // modify app config
        let app_config_path = concat_path(&self.home, "config/app.toml");
        modify_toml(
            app_config_path,
            Box::new(|v| {
                v["minimum-gas-prices"] = toml_edit::value("0.025uosmo");
                v["api"]["enable"] = toml_edit::value(false);
                v["grpc-web"]["enable"] = toml_edit::value(false);
            }),
        );

        // modify client config
        let client_chain_id = chain_id.to_string();
        let client_config_path = concat_path(&self.home, "config/client.toml");
        modify_toml(
            client_config_path,
            Box::new(move |v| {
                v["keyring-backend"] = toml_edit::value("test");
                v["output"] = toml_edit::value("json");
                v["chain-id"] = toml_edit::value(client_chain_id.clone());
                v["broadcast-mode"] = toml_edit::value("block");
            }),
        );

        self.add_default_keys();
        self.add_genesis_accs();

        self.cli()
            .cmd("gentx")
            .cmd("validator")
            .cmd(format!("{}uosmo", GENESIS_FUND))
            .arg("chain-id", chain_id)
            .run()
            .join();

        self.cli().cmd("collect-gentxs").run().join();
    }

    pub fn start(&self, addr_base: String, port_base: u32) -> (AgentHandles, OsmosisEndpoint) {
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
        let grpc_addr = get_next_addr().replace("tcp://", "");
        let pprof_addr = get_next_addr().replace("tcp://", "");

        let endpoint = OsmosisEndpoint {
            addr,
            rpc_addr,
            grpc_addr,
        };

        let node = self
            .cli()
            .cmd("start")
            .arg("address", &endpoint.addr) // default is tcp://0.0.0.0:26658
            // addrs
            .arg("p2p.laddr", p2p_addr) // default is tcp://0.0.0.0:26655
            .arg("rpc.laddr", &endpoint.rpc_addr) // default is tcp://0.0.0.0:26657
            .arg("grpc.address", &endpoint.grpc_addr) // default is 0.0.0.0:9090
            .arg("rpc.pprof_laddr", pprof_addr) // default is localhost:6060
            .spawn("COSMOS");

        endpoint.wait_for_node();

        (node, endpoint)
    }

    pub fn store_codes(
        &self,
        endpoint: &OsmosisEndpoint,
        sender: &str,
        codes: BTreeMap<String, PathBuf>,
    ) -> BTreeMap<String, u64> {
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

            let wasm_store_tx_resp: TxResponse =
                serde_json::from_str(cmd.run_with_output().join().first().unwrap()).unwrap();

            let store_code_log = wasm_store_tx_resp.logs.first().unwrap();
            let store_code_evt = store_code_log
                .events
                .iter()
                .find(|v| v.typ == "store_code")
                .unwrap();

            let code_id = &store_code_evt.attributes.last().unwrap().value;
            let code_id = code_id.parse::<u64>().unwrap();

            ret.insert(name, code_id);
        }

        ret
    }

    pub fn wasm_init<T: serde::ser::Serialize>(
        &self,
        endpoint: &OsmosisEndpoint,
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

        let init_log = wasm_init_resp.logs.first().unwrap();
        let init_evt = init_log.events.iter().find(|v| v.typ == "reply").unwrap();

        let contract_addr = &init_evt
            .attributes
            .iter()
            .find(|v| v.key == "_contract_address")
            .unwrap()
            .value;

        contract_addr.to_string()
    }

    pub fn wasm_execute<T: serde::ser::Serialize>(
        &self,
        endpoint: &OsmosisEndpoint,
        sender: &str,
        contract: &str,
        execute_msg: T,
        funds: Vec<Coin>,
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

        if funds.len() > 0 {
            cmd = cmd.arg(
                "amount",
                funds
                    .into_iter()
                    .map(|v| format!("{}{}", v.amount, v.denom))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }

        let output = serde_json::from_str(cmd.run_with_output().join().first().unwrap());

        output.unwrap()
    }

    pub fn wasm_query<T: serde::ser::Serialize, U: serde::de::DeserializeOwned>(
        &self,
        endpoint: &OsmosisEndpoint,
        contract: &str,
        query_msg: T,
    ) -> U {
        let mut cmd = self
            .cli()
            .cmd("query")
            .cmd("wasm")
            .cmd("contract-state")
            .cmd("smart")
            .cmd(contract)
            .cmd(serde_json::to_string(&query_msg).unwrap());

        cmd = endpoint.add_rpc(cmd);

        let output = serde_json::from_str(cmd.run_with_output().join().first().unwrap());

        output.unwrap()
    }

    fn add_genesis_accs(&self) {
        for name in [("validator"), ("account1"), ("account2"), ("account3")] {
            self.cli()
                .cmd("add-genesis-account")
                .cmd(self.get_addr(name))
                .cmd(format!("{}uosmo", GENESIS_FUND * 2))
                .run()
                .join();
        }
    }

    fn add_default_keys(&self) {
        for (name, mnemonic) in [
            ("validator", KEY_VALIDATOR),
            ("account1", KEY_ACCOUNTS1),
            ("account2", KEY_ACCOUNTS2),
            ("account3", KEY_ACCOUNTS3),
        ] {
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
        println!("{:?}", out);
        out.first().unwrap().clone()
    }
}
