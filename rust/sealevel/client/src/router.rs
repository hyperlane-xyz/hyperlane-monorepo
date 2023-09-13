use hyperlane_core::{utils::hex_or_base58_to_h256, H256};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    str::FromStr,
};

use solana_client::rpc_client::RpcClient;
use solana_program::instruction::Instruction;
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey, signature::Signer};

use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program_idempotent},
    read_core_program_ids, Context, CoreProgramIds,
};

fn parse_pubkey_or_default(maybe_str: Option<&String>, default: Pubkey) -> Pubkey {
    maybe_str
        .map(|s| Pubkey::from_str(s).unwrap())
        .unwrap_or(default)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalConnectionClientConfig {
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    pub mailbox: Option<Pubkey>,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    pub interchain_gas_paymaster: Option<Pubkey>,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    pub interchain_security_module: Option<Pubkey>,
}

impl OptionalConnectionClientConfig {
    pub fn mailbox(&self, default: Pubkey) -> Pubkey {
        self.mailbox.unwrap_or(default)
    }

    pub fn interchain_security_module(&self) -> Option<Pubkey> {
        self.interchain_security_module
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalOwnableConfig {
    pub owner: Option<String>,
}

impl OptionalOwnableConfig {
    pub fn owner(&self, default: Pubkey) -> Pubkey {
        parse_pubkey_or_default(self.owner.as_ref(), default)
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RouterConfig {
    pub foreign_deployment: Option<String>,
    #[serde(flatten)]
    pub ownable: OptionalOwnableConfig,
    #[serde(flatten)]
    pub connection_client: OptionalConnectionClientConfig,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RpcUrlConfig {
    pub http: String,
}

/// An abridged version of the Typescript ChainMetadata
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChainMetadata {
    chain_id: u32,
    /// Hyperlane domain, only required if differs from id above
    domain_id: Option<u32>,
    name: String,
    /// Collection of RPC endpoints
    rpc_urls: Vec<RpcUrlConfig>,
}

impl ChainMetadata {
    pub fn client(&self) -> RpcClient {
        RpcClient::new_with_commitment(self.rpc_urls[0].http.clone(), CommitmentConfig::confirmed())
    }

    pub fn domain_id(&self) -> u32 {
        self.domain_id.unwrap_or(self.chain_id)
    }
}

pub trait RouterConfigGetter {
    fn router_config(&self) -> &RouterConfig;
}

pub(crate) trait Deployable<Config: RouterConfigGetter + std::fmt::Debug>:
    ConnectionClient
{
    #[allow(clippy::too_many_arguments)]
    fn deploy(
        &self,
        ctx: &mut Context,
        key_dir: &Path,
        environments_dir: &Path,
        environment: &str,
        built_so_dir: &Path,
        chain_config: &ChainMetadata,
        app_config: &Config,
    ) -> Pubkey {
        let program_name = self.program_name(app_config);

        println!(
            "Attempting deploy {} on chain: {}\nApp config: {:?}",
            program_name, chain_config.name, app_config
        );

        let (keypair, keypair_path) = create_and_write_keypair(
            key_dir,
            format!("{}-{}.json", program_name, chain_config.name).as_str(),
            true,
        );
        let program_id = keypair.pubkey();

        deploy_program_idempotent(
            ctx.payer_keypair_path(),
            &keypair,
            keypair_path.to_str().unwrap(),
            built_so_dir
                .join(format!("{}.so", program_name))
                .to_str()
                .unwrap(),
            &chain_config.rpc_urls[0].http,
        )
        .unwrap();

        let core_program_ids =
            read_core_program_ids(environments_dir, environment, &chain_config.name);
        self.init_program_idempotent(
            ctx,
            &chain_config.client(),
            &core_program_ids,
            chain_config,
            app_config,
            program_id,
        );

        program_id
    }

    /// The program's name, i.e. the name of the program's .so file (without the .so suffix)
    /// and the name that will be used to create the keypair file
    fn program_name(&self, config: &Config) -> &str;

    fn enroll_remote_routers_instruction(
        &self,
        program_id: Pubkey,
        payer: Pubkey,
        router_configs: Vec<RemoteRouterConfig>,
    ) -> Instruction;

    fn get_routers(&self, rpc_client: &RpcClient, program_id: &Pubkey) -> HashMap<u32, H256>;

    fn init_program_idempotent(
        &self,
        ctx: &mut Context,
        client: &RpcClient,
        core_program_ids: &CoreProgramIds,
        chain_config: &ChainMetadata,
        app_config: &Config,
        program_id: Pubkey,
    );
}

pub(crate) trait ConnectionClient {
    fn get_interchain_security_module(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<Pubkey>;

    fn set_interchain_security_module_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        ism: Option<Pubkey>,
    ) -> Instruction;
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn deploy_routers<
    Config: for<'a> Deserialize<'a> + RouterConfigGetter + std::fmt::Debug,
    Deployer: Deployable<Config>,
>(
    ctx: &mut Context,
    deployer: Deployer,
    app_name: &str,
    deploy_name: &str,
    app_config_file_path: PathBuf,
    chain_config_file_path: PathBuf,
    environments_dir_path: PathBuf,
    environment: &str,
    built_so_dir_path: PathBuf,
) {
    let app_config_file = File::open(app_config_file_path).unwrap();
    let app_configs: HashMap<String, Config> = serde_json::from_reader(app_config_file).unwrap();

    let chain_config_file = File::open(chain_config_file_path).unwrap();
    let chain_configs: HashMap<String, ChainMetadata> =
        serde_json::from_reader(chain_config_file).unwrap();

    let environments_dir = create_new_directory(&environments_dir_path, environment);

    let artifacts_dir = create_new_directory(&environments_dir, app_name);
    let deploy_dir = create_new_directory(&artifacts_dir, deploy_name);
    let keys_dir = create_new_directory(&deploy_dir, "keys");

    let foreign_deployments = app_configs
        .iter()
        .map(|(chain_name, app_config)| (chain_name, app_config.router_config()))
        .filter(|(_, router_config)| router_config.foreign_deployment.is_some())
        .map(|(chain_name, router_config)| {
            let chain_config = chain_configs.get(chain_name).unwrap();
            (
                chain_config.domain_id(),
                hex_or_base58_to_h256(router_config.foreign_deployment.as_ref().unwrap()).unwrap(),
            )
        })
        .collect::<HashMap<u32, H256>>();

    let mut routers: HashMap<u32, H256> = foreign_deployments;

    let app_configs_to_deploy = app_configs
        .into_iter()
        .filter(|(_, app_config)| app_config.router_config().foreign_deployment.is_none())
        .collect::<HashMap<_, _>>();

    // Deploy to chains that don't have a foreign deployment
    for (chain_name, app_config) in app_configs_to_deploy.iter() {
        let chain_config = chain_configs
            .get(chain_name)
            .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

        if app_config.router_config().ownable.owner.is_some() {
            println!("WARNING: Ownership transfer is not yet supported in this deploy tooling, ownership is granted to the payer account");
        }

        let program_id = deployer.deploy(
            ctx,
            &keys_dir,
            &environments_dir_path,
            environment,
            &built_so_dir_path,
            chain_config,
            app_config,
        );

        routers.insert(
            chain_config.domain_id(),
            H256::from_slice(&program_id.to_bytes()[..]),
        );

        let actual_ism =
            deployer.get_interchain_security_module(&chain_config.client(), &program_id);
        let expected_ism = app_config
            .router_config()
            .connection_client
            .interchain_security_module();

        println!(
            "actual_ism {:?} expected_ism {:?}",
            actual_ism, expected_ism
        );

        if actual_ism != expected_ism {
            println!("Setting correct one...");
            ctx.new_txn()
                .add_with_description(
                    deployer.set_interchain_security_module_instruction(
                        &chain_config.client(),
                        &program_id,
                        expected_ism,
                    ),
                    format!(
                        "Setting ISM for chain: {} ({}) to {:?}",
                        chain_name,
                        chain_config.domain_id(),
                        expected_ism
                    ),
                )
                .with_client(&chain_config.client())
                .send_with_payer();
        }
    }

    // Now enroll routers
    for (chain_name, _) in app_configs_to_deploy {
        let chain_config = chain_configs
            .get(&chain_name)
            .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

        let domain_id = chain_config.domain_id();
        let program_id: Pubkey =
            Pubkey::new_from_array(*routers.get(&domain_id).unwrap().as_fixed_bytes());

        let enrolled_routers = deployer.get_routers(&chain_config.client(), &program_id);

        let expected_routers = routers
            .iter()
            .filter(|(router_domain_id, _)| *router_domain_id != &domain_id)
            .map(|(domain, router)| {
                (
                    *domain,
                    RemoteRouterConfig {
                        domain: *domain,
                        router: Some(*router),
                    },
                )
            })
            .collect::<HashMap<u32, RemoteRouterConfig>>();

        // Routers to enroll (or update to a Some value)
        let routers_to_enroll = expected_routers
            .iter()
            .filter(|(domain, router_config)| {
                enrolled_routers.get(domain) != router_config.router.as_ref()
            })
            .map(|(_, router_config)| router_config.clone());

        // Routers to remove
        let routers_to_unenroll = enrolled_routers
            .iter()
            .filter(|(domain, _)| !expected_routers.contains_key(domain))
            .map(|(domain, _)| RemoteRouterConfig {
                domain: *domain,
                router: None,
            });

        // All router config changes
        let router_configs = routers_to_enroll
            .chain(routers_to_unenroll)
            .collect::<Vec<RemoteRouterConfig>>();

        if !router_configs.is_empty() {
            println!(
                "Enrolling routers for chain: {}, program_id {}, routers: {:?}",
                chain_name, program_id, router_configs,
            );

            ctx.new_txn()
                .add(deployer.enroll_remote_routers_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    router_configs,
                ))
                .with_client(&chain_config.client())
                .send_with_payer();
        } else {
            println!(
                "No router changes for chain: {}, program_id {}",
                chain_name, program_id
            );
        }
    }

    let routers_by_name: HashMap<String, H256> = routers
        .iter()
        .map(|(domain_id, router)| {
            (
                chain_configs
                    .iter()
                    .find(|(_, chain_config)| chain_config.domain_id() == *domain_id)
                    .unwrap()
                    .0
                    .clone(),
                *router,
            )
        })
        .collect::<HashMap<String, H256>>();
    write_program_ids(&deploy_dir, &routers_by_name);
}

#[derive(Serialize, Deserialize)]
struct SerializedProgramId {
    hex: String,
    base58: String,
}

fn write_program_ids(deploy_dir: &Path, routers: &HashMap<String, H256>) {
    let serialized_program_ids = routers
        .iter()
        .map(|(chain_name, router)| {
            (
                chain_name.clone(),
                SerializedProgramId {
                    hex: format!("0x{}", hex::encode(router)),
                    base58: Pubkey::new_from_array(router.to_fixed_bytes()).to_string(),
                },
            )
        })
        .collect::<HashMap<String, SerializedProgramId>>();

    let program_ids_file = deploy_dir.join("program-ids.json");
    let program_ids_file = File::create(program_ids_file).unwrap();
    serde_json::to_writer_pretty(program_ids_file, &serialized_program_ids).unwrap();
}
