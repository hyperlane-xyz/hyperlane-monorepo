use std::{fs, path::PathBuf, thread::sleep, time::Duration};

use crate::{
    log,
    program::Program,
    utils::{concat_path, AgentHandles, TaskHandle},
};

use super::{
    constants::{CHAIN_ID, DENOM, KEY_CHAIN_VALIDATOR},
    types::Contracts,
};

const GENESIS_FUND: u128 = 1000000000000;

#[derive(Debug)]
pub struct SimApp {
    pub(crate) bin: String,
    pub(crate) home: String,
    pub(crate) addr: String,
    pub(crate) p2p_addr: String,
    pub(crate) rpc_addr: String,
    pub(crate) api_addr: String,
    pub(crate) pprof_addr: String,
}

pub(crate) fn modify_json<T: serde::de::DeserializeOwned + serde::Serialize>(
    file: impl Into<PathBuf>,
    modifier: Box<dyn Fn(&mut T)>,
) {
    let path = file.into();
    let mut config: T = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

    modifier(&mut config);

    fs::write(path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
}

/// Sim app
///
/// the sim app is a light cosmos chain that implemenets the hyperlane cosmos module
impl SimApp {
    pub fn new(bin: String, home: String, port_offset: u32) -> Self {
        let port_base = 26657 + port_offset * 5; // we increment by 5 ports as we need 5 unique ports per chain
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
        let api_addr = get_next_addr();
        let pprof_addr = get_next_addr().replace("tcp://", "");

        return SimApp {
            bin,
            home,
            addr,
            rpc_addr,
            p2p_addr,
            pprof_addr,
            api_addr,
        };
    }

    fn cli(&self) -> Program {
        Program::new(self.bin.clone()).arg("home", self.home.clone())
    }

    pub fn init(&self, domain: u32) {
        self.cli().cmd("init-sample-chain").run().join();

        // set the local domain
        let client_config_path = concat_path(&self.home, "config/genesis.json");
        modify_json::<serde_json::Value>(
            client_config_path,
            Box::new(move |config| {
                config["app_state"]["hyperlane"]["params"]["domain"] = serde_json::json!(domain);
            }),
        );
    }

    pub fn start(&mut self) -> AgentHandles {
        let node = self
            .cli()
            .cmd("start")
            .arg("address", &self.addr) // default is tcp://0.0.0.0:26658
            .arg("p2p.laddr", &self.p2p_addr) // default is tcp://0.0.0.0:26655
            .arg("rpc.laddr", &self.rpc_addr) // default is tcp://0.0.0.0:26657
            .cmd("--grpc.enable=false") // disable grpc
            .flag("api.enable") // enable api
            .arg("api.address", &self.api_addr)
            .arg("rpc.pprof_laddr", &self.pprof_addr) // default is localhost:6060
            .arg("log_level", "panic")
            .spawn("SIMAPP", None);
        sleep(Duration::from_secs(2));
        node
    }

    fn tx<'a>(&self, args: impl IntoIterator<Item = &'a str>) {
        let mut program = Program::new(self.bin.clone()).cmd("tx");
        for arg in args {
            program = program.cmd(arg);
        }
        program
            .arg("from", KEY_CHAIN_VALIDATOR.0)
            .arg("chain-id", CHAIN_ID)
            .arg("fees", format!("40000{}", DENOM))
            .arg("node", &self.rpc_addr)
            .arg("home", &self.home)
            .arg("keyring-backend", "test")
            .flag("yes")
            .run()
            .join();
        sleep(Duration::from_secs(1)); // wait for the block to mined
    }

    pub fn remote_transfer(&self, from: &str, warp_route: &str, recipient: &str, amount: u32) {
        Program::new(self.bin.clone())
            .cmd("tx")
            .cmd("hyperlane-transfer")
            .cmd("transfer")
            .cmd(warp_route)
            .cmd(recipient)
            .cmd(&format!("{amount}"))
            .arg("gas-limit", "800000")
            .arg("max-hyperlane-fee", "1000000")
            .arg("from", from)
            .arg("chain-id", CHAIN_ID)
            .arg("fees", format!("80000{}", DENOM))
            .arg("node", &self.rpc_addr)
            .arg("home", &self.home)
            .arg("keyring-backend", "test")
            .arg("gas", "400000")
            .flag("yes")
            .run()
            .join();
        sleep(Duration::from_secs(1)); // wait for the block to mined
    }

    pub fn deploy(&self, destination_domain: &str) -> Contracts {
        log!("deploying hyperlane for domain: {} ...", destination_domain);

        // create interchain gas paymaster
        // the igp address expected to be: 0xd7194459d45619d04a5a0f9e78dc9594a0f37fd6da8382fe12ddda6f2f46d647
        // TODO: test against the tx result to see if everything was created correctly
        self.tx(vec!["hyperlane", "igp", "create-igp", DENOM]);

        // set the interchain gas config -> this determines the interchain gaspayments
        // cmd is following: igp-address remote-domain exchange-rate gas-price and gas-overhead
        // this config requires a payment of at least 0.200001uhyp
        self.tx(vec![
            "hyperlane",
            "igp",
            "set-destination-gas-config",
            "0xd7194459d45619d04a5a0f9e78dc9594a0f37fd6da8382fe12ddda6f2f46d647",
            destination_domain,
            "1",
            "1",
            "200000",
        ]);

        // create ism
        // cmd is following: validator addresses threshold
        // expected ism address: 0x934b867052ca9c65e33362112f35fb548f8732c2fe45f07b9c591b38e865def0
        let address = "0xb05b6a0aa112b61a7aa16c19cac27d970692995e"; // TODO: convert KEY_VALIDATOR to eth address
        self.tx(vec![
            "hyperlane",
            "ism",
            "create-multisig-ism",
            &address,
            "1",
        ]);

        // create mailbox
        // cmd is following: default-ism default-igp
        // expected mailbox address: 0x8ba32dc5efa59ba35e2cf6f541dfacbbf49c95891e5afc2c9ca36142de8fb880
        self.tx(vec![
            "hyperlane",
            "mailbox",
            "create-mailbox",
            "0x934b867052ca9c65e33362112f35fb548f8732c2fe45f07b9c591b38e865def0",
            "0xd7194459d45619d04a5a0f9e78dc9594a0f37fd6da8382fe12ddda6f2f46d647",
        ]);

        // create warp route
        // cmd is following: origin-mailbox denom receiver-domain receiver-contract
        // expected address: 0x820e1a4aa659041704df5567a73778be57615a84041680218d18894bec1695b2
        self.tx(vec![
            "hyperlane-transfer",
            "create-collateral-token",
            "0x8ba32dc5efa59ba35e2cf6f541dfacbbf49c95891e5afc2c9ca36142de8fb880",
            DENOM,
            destination_domain,
            "0xb32677d8121a50c7b960b8561ead86278a7d75ec786807983e1eebfcbc2d9cfc",
        ]);

        // create warp route
        // cmd is following: origin-mailbox denom receiver-domain receiver-contract
        // expected address: 0x820e1a4aa659041704df5567a73778be57615a84041680218d18894bec1695b2
        self.tx(vec![
            "hyperlane-transfer",
            "create-synthetic-token",
            "0x8ba32dc5efa59ba35e2cf6f541dfacbbf49c95891e5afc2c9ca36142de8fb880",
            destination_domain,
            "0x820e1a4aa659041704df5567a73778be57615a84041680218d18894bec1695b2",
        ]);

        Contracts {
            mailbox: "0x8ba32dc5efa59ba35e2cf6f541dfacbbf49c95891e5afc2c9ca36142de8fb880"
                .to_owned(),
            igp: "0xd7194459d45619d04a5a0f9e78dc9594a0f37fd6da8382fe12ddda6f2f46d647".to_owned(),
            tokens: vec![
                "0x820e1a4aa659041704df5567a73778be57615a84041680218d18894bec1695b2".to_owned(),
            ],
        }
    }
}
