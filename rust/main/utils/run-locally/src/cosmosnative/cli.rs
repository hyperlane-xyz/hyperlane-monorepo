use std::{thread::sleep, time::Duration};

use crate::{
    log,
    program::Program,
    utils::{AgentHandles, TaskHandle},
};

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
    }

    pub fn start(&mut self) -> AgentHandles {
        let node = self
            .cli()
            .cmd("start")
            .arg("address", &self.addr) // default is tcp://0.0.0.0:26658
            .arg("p2p.laddr", &self.p2p_addr) // default is tcp://0.0.0.0:26655
            .arg("rpc.laddr", &self.rpc_addr) // default is tcp://0.0.0.0:26657
            .cmd("--grpc.enable=true") // enable grpc
            .flag("api.enable") // enable api
            .arg("api.address", &self.api_addr)
            .arg("grpc.address", &self.grpc_addr)
            .arg("rpc.pprof_laddr", &self.pprof_addr) // default is localhost:6060
            .arg("log_level", "panic")
            .spawn("SIMAPP", None);
        sleep(Duration::from_secs(5));
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
            .filter_logs(|_| false)
            .run()
            .join();
        sleep(Duration::from_secs(5)); // wait for the block to mined
    }

    pub fn remote_transfer(
        &self,
        from: &str,
        token_id: &str,
        remote_domain: &str,
        recipient: &str,
        amount: u32,
    ) {
        Program::new(self.bin.clone())
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
            .flag("yes")
            .filter_logs(|_| false)
            .run()
            .join();
        sleep(Duration::from_secs(5)); // wait for the block to mined
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
        Program::new(self.bin.clone())
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
            .filter_logs(|_| false)
            .flag("yes")
            .run()
            .join();
        sleep(Duration::from_secs(5)); // wait for the block to mined

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
