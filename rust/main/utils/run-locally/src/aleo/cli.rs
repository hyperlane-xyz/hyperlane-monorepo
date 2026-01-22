use std::thread::sleep;
use std::time::Duration;

use aleo_serialize_macro::aleo_serialize;

use crate::aleo::types::{Contracts, CoreContracts, TokenContract, WarpContracts};
use crate::aleo::utils::{
    domain_u32, encode_fixed_program_name, get_program_address, to_plaintext_string,
};
use crate::aleo::{CONSENSUS_HEIGHTS, KEY, NETWORK};
use crate::logging::log;
use crate::program::Program;
use crate::utils::{AgentHandles, TaskHandle};

// Associated program names
const PROGRAM_VALIDATOR_ANNOUNCE: &str = "validator_announce";
const PROGRAM_HYP_NATIVE: &str = "warp/hyp_native";
const PROGRAM_HYP_SYNTHETIC: &str = "warp/hyp_synthetic";
const PROGRAM_ISM_MANAGER: &str = "ism_manager";
const PROGRAM_HOOK_MANAGER: &str = "hook_manager";
const PROGRAM_MAILBOX: &str = "mailbox";

// Addresses (hard-coded)
const ADDR_MAILBOX: &str = "aleo1999jqmw6mazgnlk22fgt3qytykw8s0248hnkqt6m557xqcx6w5xsg4raem";
const ADDR_VALIDATOR_ANNOUNCE: &str =
    "aleo18a4jmw2eaq94efktm23r39v8l3w3e6q9gw2t0jjwk0lmzjjf95xqf6fz64";
const ADDR_MULTISIG_ISM: &str = "aleo1a5p366wzhnzj9fk9nlswjt3wk2gek0e2qquz7428ku340gxjcsxs4uqd2t";
const ADDR_ROUTING_ISM: &str = "aleo1f5mzhgkks98p6ues5axvsjh49fw5frk7nnnrumz2n6ez5zw4ws9qh42cf6";
const ADDR_MERKLE_TREE_HOOK: &str =
    "aleo19wjjsxgnnqd8agxkl00xecc8vmlhp8y4t6n3au42l8sl92n2uyzst9nlpr";
const ADDR_IGP: &str = "aleo1n2f30mtkm3ttfhxlnw92pn8j4jp88v5x9606fj8u3rl0cgdys5ys2gxf7h";
const ADDR_DISPATCH_PROXY: &str = "aleo1jgnn4lla2d6v0llffwhp6s87x03xqtdezwkzxv0u2ehq2wmqcsqqganvw4";

#[derive(Debug, Clone)]
pub struct AleoCli {
    leo: String,
    pub endpoint: String,
    cwd: String,
    port: u32,
}

impl AleoCli {
    pub fn new(leo: String, hyperlane_aleo: String, port: u32) -> AleoCli {
        Self {
            leo,
            port,
            endpoint: format!("http://localhost:{}", port),
            cwd: hyperlane_aleo,
        }
    }

    fn cli(&self) -> Program {
        Program::new(self.leo.clone()).working_dir(self.cwd.clone())
    }

    pub fn start(&self) -> AgentHandles {
        let node = self
            .cli()
            .cmd("devnode")
            .cmd("start")
            .arg("socket-addr", format!("127.0.0.1:{}", self.port))
            .arg("private-key", KEY.1)
            .arg("network", NETWORK)
            .arg("consensus-heights", CONSENSUS_HEIGHTS)
            .arg("endpoint", &self.endpoint)
            .filter_logs(|_| false)
            .spawn("DEVNODE", None);

        let _ = sleep(Duration::from_secs(5));

        // Advance 20 blocks to ensure the node is fully started
        Program::new("curl")
            .raw_arg("-X")
            .raw_arg("POST")
            .cmd(format!("{}/testnet/block/create", self.endpoint))
            .raw_arg("-H")
            .raw_arg("Content-Type: application/json")
            .raw_arg("-d")
            .raw_arg("{\"num_blocks\": 20}")
            .filter_logs(|_| false)
            .run()
            .join();

        node
    }

    fn base(&self) -> Program {
        self.cli().filter_logs(|_| false)
    }

    fn execute<'a>(&self, path: &str, method: &str, args: &[&str]) {
        // Shared executor for repeated CLI patterns
        let mut program = self.base().cmd("execute").cmd(method);
        for a in args {
            program = program.cmd(*a);
        }
        program
            .arg("path", path)
            .arg("private-key", KEY.1)
            .arg("network", NETWORK)
            .arg("consensus-heights", CONSENSUS_HEIGHTS)
            .arg("endpoint", &self.endpoint)
            .flag("broadcast")
            .flag("yes")
            .flag("skip-execute-proof")
            .run()
            .join();
    }

    fn deploy_program(&self, program: &str, extra: Option<(&str, &str)>) {
        let mut p = self.base().cmd("deploy").arg("path", program);
        if let Some((k, v)) = extra {
            p = p.arg(k, v);
        }
        p.flag("broadcast")
            .flag("yes")
            .arg("endpoint", &self.endpoint)
            .flag("skip-deploy-certificate")
            .run()
            .join();
    }

    pub fn deploy_core_contracts(
        &self,
        local_domain: u32,
        remote_domains: &[u32],
    ) -> CoreContracts {
        log!("Deploying core contracts for domain: {}", local_domain);

        // Deploy programs
        for (prog, extra) in [
            (PROGRAM_VALIDATOR_ANNOUNCE, None),
            (PROGRAM_HYP_NATIVE, None),
            (
                PROGRAM_HYP_SYNTHETIC,
                Some(("skip", "manager,mailbox,proxy")),
            ),
        ] {
            self.deploy_program(prog, extra);
        }

        // Init validator announce
        self.execute(
            PROGRAM_VALIDATOR_ANNOUNCE,
            "init",
            &[ADDR_MAILBOX, &domain_u32(local_domain)],
        );

        #[aleo_serialize]
        #[derive(Clone, Copy)]
        struct AleoEthAddress {
            bytes: [u8; 20],
        }

        // Prepare validator set
        let validator: [u8; 20] = hex::decode(KEY.0).expect("hex").try_into().expect("len20");
        let mut validators = [AleoEthAddress { bytes: [0u8; 20] }; 6];
        validators[0] = AleoEthAddress { bytes: validator };
        let validators_str = to_plaintext_string(&validators);

        // Init ISM manager
        self.execute(
            PROGRAM_ISM_MANAGER,
            "init_message_id_multisig",
            &[&validators_str, "1u8", "1u8"],
        );
        self.execute(PROGRAM_ISM_MANAGER, "init_domain_routing", &[]);

        for domain in remote_domains {
            self.execute(
                PROGRAM_ISM_MANAGER,
                "set_domain",
                &[ADDR_ROUTING_ISM, &domain_u32(*domain), ADDR_MULTISIG_ISM],
            );
        }

        // Init hooks
        self.execute(
            PROGRAM_HOOK_MANAGER,
            "init_merkle_tree",
            &[ADDR_DISPATCH_PROXY],
        );
        self.execute(PROGRAM_HOOK_MANAGER, "init_igp", &[]);

        // Init mailbox
        self.execute(PROGRAM_MAILBOX, "init", &[&domain_u32(local_domain)]);

        // Mailbox configuration
        self.execute(PROGRAM_MAILBOX, "set_default_hook", &[ADDR_IGP]);
        self.execute(
            PROGRAM_MAILBOX,
            "set_required_hook",
            &[ADDR_MERKLE_TREE_HOOK],
        );
        self.execute(PROGRAM_MAILBOX, "set_default_ism", &[ADDR_ROUTING_ISM]);
        self.execute(
            PROGRAM_MAILBOX,
            "set_dispatch_proxy",
            &[ADDR_DISPATCH_PROXY],
        );

        #[aleo_serialize]
        struct DomainGasConfig {
            gas_overhead: u128,
            exchange_rate: u128,
            gas_price: u128,
        }

        let config = to_plaintext_string(&DomainGasConfig {
            gas_overhead: 10,
            exchange_rate: 10_000_000_000u128,
            gas_price: 1u128,
        });

        for domain in remote_domains {
            self.execute(
                PROGRAM_HOOK_MANAGER,
                "set_destination_gas_config",
                &[ADDR_IGP, &domain_u32(*domain), &config],
            );
        }

        log!(
            "Core contracts deployed and configured successfully for domain {}",
            local_domain
        );
        CoreContracts {
            mailbox: ADDR_MAILBOX.to_owned(),
            merkle_tree_hook: ADDR_MERKLE_TREE_HOOK.to_owned(),
            interchain_gas_paymaster: ADDR_IGP.to_owned(),
            validator_announce: ADDR_VALIDATOR_ANNOUNCE.to_owned(),
        }
    }

    pub fn init_warp_contracts(&self) -> WarpContracts {
        let hyp_native_pt = encode_fixed_program_name("hyp_native.aleo");
        let hyp_synthetic_pt = encode_fixed_program_name("hyp_synthetic.aleo");

        log!("Deploying collateral token...");
        self.execute(PROGRAM_HYP_NATIVE, "init", &[&hyp_native_pt, "0u8"]);

        log!("Deploying synthetic token...");
        self.execute(
            PROGRAM_HYP_SYNTHETIC,
            "init",
            &[&hyp_synthetic_pt, "0u128", "0u128", "6u8", "6u8"],
        );

        let native = TokenContract {
            program: PROGRAM_HYP_NATIVE.to_owned(),
            address: get_program_address(
                "aleo10t2uecxm36lww6jakrfc3jcfelc42duq3km3g8aa3pn4vwyj2sgsrvql6f",
            ),
        };
        let synthetic = TokenContract {
            program: PROGRAM_HYP_SYNTHETIC.to_owned(),
            address: get_program_address(
                "aleo1f607szye6juzq62p2qs9all34pnd0sjaghttavd6pf0z6taanc9qksv702",
            ),
        };

        WarpContracts { native, synthetic }
    }

    pub fn enroll_remote_routers(
        &self,
        token: &str,
        routers: impl IntoIterator<Item = (u32, TokenContract)>,
    ) {
        log!("Enrolling remote routers for token {}", token);
        for (domain, router) in routers {
            let recipient_string = to_plaintext_string(&router.address);
            self.execute(
                token,
                "enroll_remote_router",
                &[&domain_u32(domain), &recipient_string, "1u128"],
            );
        }
        log!("All remote routers enrolled successfully");
    }

    pub fn remote_transfer(&self, token: &str, destination: u32) {
        log!(
            "Initiating remote transfer of token {} to domain {}",
            token,
            destination
        );

        #[aleo_serialize]
        struct RemoteRouter {
            domain: u32,
            recipient: [u8; 32],
            gas: u128,
        }

        let recipient =
            hex::decode("4e9fe80899d4b820694150205efff1a866d7c25d45d6beb1ba0a5e2d2fbd9e0a")
                .expect("correct hex");
        let router = to_plaintext_string(&RemoteRouter {
            domain: destination,
            recipient: recipient.try_into().expect("len32"),
            gas: 1,
        });

        self.execute(token, "transfer_remote", &vec![
            "{token_type: 0u8, token_owner: aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px, ism: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc, hook: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc, scale: 0u8}",
            &format!("{{default_hook: {ADDR_IGP}, required_hook: {ADDR_MERKLE_TREE_HOOK}}}"),
            &router,
            &domain_u32(destination),
            "[34922309281260474190457069241198628893u128,10290470785006546030683794163620329388u128]",
            "11u64",
            &format!("[{{spender: {ADDR_IGP}, amount: 11u64}},{{spender: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc, amount: 0u64}},{{spender: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc, amount: 0u64}},{{spender: aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc, amount: 0u64}}]")
        ]);
        log!("Remote transfer completed successfully");
    }

    /// Will spin up a local Aleo node and deploy all necessary contracts.
    pub fn initialize(&self, origin_domain: u32, remotes: Vec<u32>) -> (Contracts, AgentHandles) {
        // Start the node first
        let handles = self.start();

        log!(
            "Deploying contracts for {} domains: {:?}",
            origin_domain,
            remotes
        );

        log!("Step 1: Deploying core contracts for each domain");
        let core = self.deploy_core_contracts(origin_domain, &remotes);

        // 2. Deploy warp contracts
        log!("Step 2: Deploying warp contracts for each domain");
        let warp = self.init_warp_contracts();

        // 3. Enroll remote routers
        log!("Step 3: Enrolling remote routers across domains");
        // We know that each domain will be a mirror of the local domain
        // This means all of the addresses will be the same across domains
        // Always connect the native <> synthetic tokens across domains

        self.enroll_remote_routers(
            &warp.native.program,
            remotes.iter().map(|d| (*d, warp.synthetic.clone())),
        );

        self.enroll_remote_routers(
            &warp.synthetic.program,
            remotes.iter().map(|d| (*d, warp.native.clone())),
        );

        log!("Contract deployment completed successfully");
        (
            Contracts {
                mailbox: core.mailbox,
                merkle_tree_hook: core.merkle_tree_hook,
                igp: core.interchain_gas_paymaster,
                validator_announce: core.validator_announce,
                native: warp.native.program,
            },
            handles,
        )
    }
}
