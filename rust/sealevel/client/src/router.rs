use hyperlane_core::{utils::hex_or_base58_to_h256, H256};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
};

use solana_client::rpc_client::RpcClient;
use solana_program::instruction::Instruction;
use solana_sdk::{
    account_utils::StateMut,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
};

use account_utils::DiscriminatorData;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_igp::accounts::{Igp, InterchainGasPaymasterType, OverheadIgp};

use crate::{
    adjust_gas_price_if_needed,
    artifacts::{write_json, HexAndBase58ProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    read_core_program_ids, warp_route, Context, CoreProgramIds,
};

/// Optional connection client configuration.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalConnectionClientConfig {
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    mailbox: Option<Pubkey>,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    interchain_gas_paymaster: Option<Pubkey>,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    interchain_security_module: Option<Pubkey>,
}

impl OptionalConnectionClientConfig {
    pub fn mailbox(&self, default: Pubkey) -> Pubkey {
        self.mailbox.unwrap_or(default)
    }

    pub fn interchain_security_module(&self) -> Option<Pubkey> {
        self.interchain_security_module
    }

    /// Uses the configured IGP account, if Some, to get the IGP program ID
    /// and generate a config of the form Some((program_id, Igp account)).
    pub fn interchain_gas_paymaster_config(
        &self,
        client: &RpcClient,
    ) -> Option<(Pubkey, InterchainGasPaymasterType)> {
        if let Some(igp_pubkey) = self.interchain_gas_paymaster {
            let account = client
                .get_account(&self.interchain_gas_paymaster.unwrap())
                .unwrap();

            match &account.data[1..9] {
                Igp::DISCRIMINATOR_SLICE => {
                    Some((account.owner, InterchainGasPaymasterType::Igp(igp_pubkey)))
                }
                OverheadIgp::DISCRIMINATOR_SLICE => Some((
                    account.owner,
                    InterchainGasPaymasterType::OverheadIgp(igp_pubkey),
                )),
                _ => {
                    panic!("Invalid IGP account configured {}", igp_pubkey);
                }
            }
        } else {
            None
        }
    }
}

/// Optional ownable configuration.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalOwnableConfig {
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    pub owner: Option<Pubkey>,
}

impl OptionalOwnableConfig {
    pub fn owner(&self, default: Pubkey) -> Pubkey {
        self.owner.unwrap_or(default)
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GasRouterConfigSchema {
    /// The amount of gas this handler is expected to use.
    pub gas: Option<u64>,
}

/// Router configuration.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RouterConfig {
    // Kept as a string to allow for hex or base58
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
    // Can be a string or a number
    chain_id: serde_json::Value,
    /// Hyperlane domain, only required if differs from id above
    domain_id: Option<u32>,
    name: String,
    /// Collection of RPC endpoints
    rpc_urls: Vec<RpcUrlConfig>,
    pub is_testnet: Option<bool>,
}

impl ChainMetadata {
    pub fn client(&self) -> RpcClient {
        RpcClient::new_with_commitment(self.rpc_urls[0].http.clone(), CommitmentConfig::confirmed())
    }

    pub fn domain_id(&self) -> u32 {
        self.domain_id.unwrap_or_else(|| {
            // Try to parse as a number, otherwise panic, as the domain ID must
            // be specified if the chain id is not a number.
            self.chain_id
                .as_u64()
                .and_then(|v| v.try_into().ok())
                .unwrap_or_else(|| {
                    panic!(
                        "Unable to get domain ID for chain {:?}: domain_id is undefined and could not fall back to chain_id {:?}",
                        self.name, self.chain_id
                    )
                })
        })
    }
}

pub trait RouterConfigGetter {
    fn router_config(&self) -> &RouterConfig;
}

pub(crate) trait RouterDeployer<Config: RouterConfigGetter + std::fmt::Debug>:
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
        existing_program_ids: Option<&HashMap<String, Pubkey>>,
    ) -> Pubkey {
        let program_name = self.program_name(app_config);

        println!(
            "Attempting deploy {} on chain: {}\nApp config: {:?}",
            program_name, chain_config.name, app_config
        );

        let program_id = existing_program_ids
            .and_then(|existing_program_ids| {
                existing_program_ids.get(&chain_config.name).and_then(|id| {
                    chain_config
                        .client()
                        .get_account_with_commitment(id, ctx.commitment)
                        .unwrap()
                        .value
                        .map(|_| {
                            println!("Recovered existing program id {}", id);
                            *id
                        })
                })
            })
            .unwrap_or_else(|| {
                let chain_program_name = format!("{}-{}", program_name, chain_config.name);

                let program_id = deploy_program(
                    ctx.payer_keypair_path(),
                    key_dir,
                    &chain_program_name,
                    built_so_dir
                        .join(format!("{}.so", program_name))
                        .to_str()
                        .unwrap(),
                    &chain_config.rpc_urls[0].http,
                    chain_config.domain_id(),
                )
                .unwrap();

                program_id
            });

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

    fn verify_config(
        &self,
        _ctx: &mut Context,
        _app_configs: &HashMap<String, Config>,
        _app_configs_to_deploy: &HashMap<&String, &Config>,
        _chain_configs: &HashMap<String, ChainMetadata>,
    ) {
        // By default, do nothing.
    }

    fn init_program_idempotent(
        &self,
        ctx: &mut Context,
        client: &RpcClient,
        core_program_ids: &CoreProgramIds,
        chain_config: &ChainMetadata,
        app_config: &Config,
        program_id: Pubkey,
    );

    fn post_deploy(
        &self,
        _ctx: &mut Context,
        _app_configs: &HashMap<String, Config>,
        _app_configs_to_deploy: &HashMap<&String, &Config>,
        _chain_configs: &HashMap<String, ChainMetadata>,
        _routers: &HashMap<u32, H256>,
    ) {
        // By default, do nothing.
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
}

pub(crate) trait Ownable {
    /// Gets the owner configured on-chain.
    fn get_owner(&self, client: &RpcClient, program_id: &Pubkey) -> Option<Pubkey>;

    /// Gets an instruction to set the owner.
    fn set_owner_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        new_owner: Option<Pubkey>,
    ) -> Instruction;
}

pub(crate) trait ConnectionClient: Ownable {
    /// Gets the interchain security module configured on-chain.
    fn get_interchain_security_module(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<Pubkey>;

    /// Gets an instruction to set the interchain security module.
    fn set_interchain_security_module_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        ism: Option<Pubkey>,
    ) -> Instruction;

    /// Gets the IGP configured on-chain.
    fn get_interchain_gas_paymaster(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<(Pubkey, InterchainGasPaymasterType)>;

    /// Gets an instruction to set the IGP.
    fn set_interchain_gas_paymaster_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        igp_config: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) -> Option<Instruction>;
}

/// Idempotently deploys routers on multiple Sealevel chains and enrolls all routers (including
/// foreign deployments) on each Sealevel chain.
#[allow(clippy::too_many_arguments)]
pub(crate) fn deploy_routers<
    Config: for<'a> Deserialize<'a> + RouterConfigGetter + std::fmt::Debug + Clone,
    Deployer: RouterDeployer<Config>,
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
    // Load the app configs from the app config file.
    let app_config_file = File::open(app_config_file_path).unwrap();
    let app_configs: HashMap<String, Config> = serde_json::from_reader(app_config_file).unwrap();

    // Load the chain configs from the chain config file.
    let chain_config_file = File::open(chain_config_file_path).unwrap();
    let chain_configs: HashMap<String, ChainMetadata> =
        serde_json::from_reader(chain_config_file).unwrap();

    let environments_dir = create_new_directory(&environments_dir_path, environment);

    let artifacts_dir = create_new_directory(&environments_dir, app_name);
    let deploy_dir = create_new_directory(&artifacts_dir, deploy_name);
    let keys_dir = create_new_directory(&deploy_dir, "keys");

    let existing_program_ids = read_router_program_ids(&deploy_dir);

    // Builds a HashMap of all the foreign deployments from the app config.
    // These domains with foreign deployments will not have any txs / deployments
    // made directly to them, but the routers will be enrolled on the other chains.
    let foreign_deployments = app_configs
        .iter()
        .filter_map(|(chain_name, app_config)| {
            app_config
                .router_config()
                .foreign_deployment
                .as_ref()
                .map(|foreign_deployment| {
                    let chain_config = chain_configs.get(chain_name).unwrap();
                    (
                        chain_config.domain_id(),
                        hex_or_base58_to_h256(foreign_deployment).unwrap(),
                    )
                })
        })
        .collect::<HashMap<u32, H256>>();

    // A map of all the routers, including the foreign deployments.
    let mut routers: HashMap<u32, H256> = foreign_deployments;

    // Non-foreign app configs to deploy to.
    let app_configs_to_deploy = app_configs
        .iter()
        .filter(|(_, app_config)| app_config.router_config().foreign_deployment.is_none())
        .collect::<HashMap<_, _>>();

    // Verify the configuration.
    println!("Verifying configuration...");
    deployer.verify_config(ctx, &app_configs, &app_configs_to_deploy, &chain_configs);
    println!("Configuration successfully verified!");

    warp_route::install_spl_token_cli();

    // Now we deploy to chains that don't have a foreign deployment
    for (chain_name, app_config) in app_configs_to_deploy.iter() {
        let chain_config = chain_configs
            .get(*chain_name)
            .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

        adjust_gas_price_if_needed(chain_name.as_str(), ctx);

        // Deploy - this is idempotent.
        let program_id = deployer.deploy(
            ctx,
            &keys_dir,
            &environments_dir_path,
            environment,
            &built_so_dir_path,
            chain_config,
            app_config,
            existing_program_ids.as_ref(),
        );

        // Add the router to the list of routers.
        routers.insert(
            chain_config.domain_id(),
            H256::from_slice(&program_id.to_bytes()[..]),
        );

        configure_connection_client(
            ctx,
            &deployer,
            &program_id,
            app_config.router_config(),
            chain_config,
        );

        configure_owner(
            ctx,
            &deployer,
            &program_id,
            app_config.router_config(),
            chain_config,
        );

        configure_upgrade_authority(ctx, &program_id, app_config.router_config(), chain_config);
    }

    // Now enroll all the routers.
    enroll_all_remote_routers(
        &deployer,
        ctx,
        &app_configs_to_deploy,
        &chain_configs,
        &routers,
    );

    // Call the post-deploy hook.
    deployer.post_deploy(
        ctx,
        &app_configs,
        &app_configs_to_deploy,
        &chain_configs,
        &routers,
    );

    // Now write the program ids to a file!
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
    write_router_program_ids(&deploy_dir, &routers_by_name);
}

// Idempotent.
// TODO: This should really be brought out into some nicer abstraction, and we should
// also look for IGP inconsistency etc.
fn configure_connection_client(
    ctx: &mut Context,
    deployer: &impl ConnectionClient,
    program_id: &Pubkey,
    router_config: &RouterConfig,
    chain_config: &ChainMetadata,
) {
    let client = chain_config.client();

    let actual_ism = deployer.get_interchain_security_module(&client, program_id);
    let expected_ism = router_config.connection_client.interchain_security_module();

    let owner = deployer.get_owner(&client, program_id);

    if actual_ism != expected_ism {
        if let Some(owner) = owner {
            ctx.new_txn()
                .add_with_description(
                    deployer.set_interchain_security_module_instruction(
                        &client,
                        program_id,
                        expected_ism,
                    ),
                    format!(
                        "Setting ISM for chain: {} ({}) to {:?}",
                        chain_config.name,
                        chain_config.domain_id(),
                        expected_ism
                    ),
                )
                .with_client(&client)
                .send_with_pubkey_signer(&owner);
        } else {
            println!(
                "WARNING: Cannot set ISM for chain: {} ({}) to {:?}, the existing owner is None",
                chain_config.name,
                chain_config.domain_id(),
                expected_ism
            );
        }
    }

    let actual_igp = deployer.get_interchain_gas_paymaster(&client, program_id);
    let expected_igp = router_config
        .connection_client
        .interchain_gas_paymaster_config(&client);

    if actual_igp != expected_igp {
        let instruction = deployer.set_interchain_gas_paymaster_instruction(
            &client,
            program_id,
            expected_igp.clone(),
        );
        if let Some(instruction) = instruction {
            if let Some(owner) = owner {
                ctx.new_txn()
                    .add_with_description(
                        instruction,
                        format!(
                            "Setting IGP for chain: {} ({}) to {:?}",
                            chain_config.name,
                            chain_config.domain_id(),
                            expected_igp
                        ),
                    )
                    .with_client(&client)
                    .send_with_pubkey_signer(&owner);
            } else {
                println!(
                    "WARNING: Cannot set IGP for chain: {} ({}) to {:?}, the existing owner is None",
                    chain_config.name, chain_config.domain_id(), expected_igp
                );
            }
        } else {
            println!("WARNING: Invalid configured IGP {:?}, expected {:?} for chain {} ({}), but cannot craft instruction to change it", actual_igp, expected_igp, chain_config.name, chain_config.domain_id());
        }
    }
}

// Idempotent.
// TODO: This should really be brought out into some nicer abstraction
fn configure_owner(
    ctx: &mut Context,
    deployer: &impl ConnectionClient,
    program_id: &Pubkey,
    router_config: &RouterConfig,
    chain_config: &ChainMetadata,
) {
    let client = chain_config.client();

    let actual_owner = deployer.get_owner(&client, program_id);
    let expected_owner = Some(router_config.ownable.owner(ctx.payer_pubkey));

    if actual_owner != expected_owner {
        if let Some(actual_owner) = actual_owner {
            ctx.new_txn()
                .add_with_description(
                    deployer.set_owner_instruction(&client, program_id, expected_owner),
                    format!(
                        "Setting owner for chain: {} ({}) to {:?}",
                        chain_config.name,
                        chain_config.domain_id(),
                        expected_owner,
                    ),
                )
                .with_client(&client)
                .send_with_pubkey_signer(&actual_owner);
        } else {
            // Flag if we can't change the owner
            println!(
                "WARNING: Ownership transfer cannot be completed for chain: {} ({}) from {:?} to {:?}, the existing owner is None",
                chain_config.name,
                chain_config.domain_id(),
                actual_owner,
                expected_owner,
            );
            return;
        }

        // Sanity check that it was updated!

        // Sleep 5 seconds for the owner to update
        std::thread::sleep(std::time::Duration::from_secs(5));

        let new_owner = deployer.get_owner(&client, program_id);
        assert_eq!(new_owner, expected_owner);
    }
}

/// Idempotent. Attempts to set the upgrade authority to the intended owner if
/// the payer can change the upgrade authority.
fn configure_upgrade_authority(
    ctx: &mut Context,
    program_id: &Pubkey,
    router_config: &RouterConfig,
    chain_config: &ChainMetadata,
) {
    let client = chain_config.client();

    let actual_upgrade_authority = get_program_upgrade_authority(&client, program_id).unwrap();
    let expected_upgrade_authority = Some(router_config.ownable.owner(ctx.payer_pubkey));

    // And the upgrade authority is not what we expect...
    if actual_upgrade_authority.is_some() && actual_upgrade_authority != expected_upgrade_authority
    {
        if let Some(actual_upgrade_authority) = actual_upgrade_authority {
            // Then set the upgrade authority to what we expect.
            ctx.new_txn()
                .add_with_description(
                    bpf_loader_upgradeable::set_upgrade_authority(
                        program_id,
                        &actual_upgrade_authority,
                        expected_upgrade_authority.as_ref(),
                    ),
                    format!(
                        "Setting upgrade authority for chain: {} ({}) to {:?}",
                        chain_config.name,
                        chain_config.domain_id(),
                        expected_upgrade_authority,
                    ),
                )
                .with_client(&client)
                .send_with_pubkey_signer(&actual_upgrade_authority);
        } else {
            // Flag if we can't change the upgrade authority
            println!(
                "WARNING: Upgrade authority transfer cannot be completed for chain: {} ({}) from {:?} to {:?}, the existing upgrade authority is None",
                chain_config.name,
                chain_config.domain_id(),
                actual_upgrade_authority,
                expected_upgrade_authority,
            );
            return;
        }

        // Sanity check that it was updated!

        // Sleep 5 seconds for the upgrade authority to update
        std::thread::sleep(std::time::Duration::from_secs(5));

        let new_upgrade_authority = get_program_upgrade_authority(&client, program_id).unwrap();
        assert_eq!(new_upgrade_authority, expected_upgrade_authority);
    }
}

fn get_program_upgrade_authority(
    client: &RpcClient,
    program_id: &Pubkey,
) -> Result<Option<Pubkey>, &'static str> {
    let program_account = client.get_account(program_id).unwrap();
    // If the program isn't upgradeable, exit
    if program_account.owner != bpf_loader_upgradeable::id() {
        return Err("Program is not upgradeable");
    }

    // The program id must actually be a program
    let programdata_address = if let Ok(UpgradeableLoaderState::Program {
        programdata_address,
    }) = program_account.state()
    {
        programdata_address
    } else {
        return Err("Unable to deserialize program account");
    };

    let program_data_account = client.get_account(&programdata_address).unwrap();

    // If the program data account somehow isn't deserializable, exit
    let actual_upgrade_authority = if let Ok(UpgradeableLoaderState::ProgramData {
        upgrade_authority_address,
        slot: _,
    }) = program_data_account.state()
    {
        upgrade_authority_address
    } else {
        return Err("Unable to deserialize program data account");
    };

    Ok(actual_upgrade_authority)
}

/// For each chain in app_configs_to_deploy, enrolls all the remote routers.
/// Idempotent.
fn enroll_all_remote_routers<
    Config: for<'a> Deserialize<'a> + RouterConfigGetter + std::fmt::Debug + Clone,
>(
    deployer: &impl RouterDeployer<Config>,
    ctx: &mut Context,
    app_configs_to_deploy: &HashMap<&String, &Config>,
    chain_configs: &HashMap<String, ChainMetadata>,
    routers: &HashMap<u32, H256>,
) {
    for (chain_name, _) in app_configs_to_deploy.iter() {
        adjust_gas_price_if_needed(chain_name.as_str(), ctx);
        let chain_config = chain_configs
            .get(*chain_name)
            .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));
        let client = chain_config.client();

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
            adjust_gas_price_if_needed(chain_name.as_str(), ctx);

            let owner = deployer.get_owner(&client, &program_id);

            if let Some(owner) = owner {
                ctx.new_txn()
                    .add_with_description(
                        deployer.enroll_remote_routers_instruction(
                            program_id,
                            owner,
                            router_configs.clone(),
                        ),
                        format!(
                            "Enrolling routers for chain: {}, program_id {}, routers: {:?}",
                            chain_name, program_id, router_configs,
                        ),
                    )
                    .with_client(&chain_config.client())
                    .send_with_pubkey_signer(&owner);
            } else {
                println!(
                    "WARNING: Cannot enroll routers for chain: {} ({}) with program_id {}, the existing owner is None",
                    chain_name, domain_id, program_id
                );
            }
        } else {
            println!(
                "No router changes for chain: {}, program_id {}",
                chain_name, program_id
            );
        }
    }
}

// Writes router program IDs as hex and base58.
fn write_router_program_ids(deploy_dir: &Path, routers: &HashMap<String, H256>) {
    let serialized_program_ids = routers
        .iter()
        .map(|(chain_name, router)| (chain_name.clone(), (*router).into()))
        .collect::<HashMap<String, HexAndBase58ProgramIdArtifact>>();

    let program_ids_file = deploy_dir.join("program-ids.json");
    write_json(&program_ids_file, serialized_program_ids);
}

fn read_router_program_ids(deploy_dir: &Path) -> Option<HashMap<String, Pubkey>> {
    let program_ids_file = deploy_dir.join("program-ids.json");

    if !program_ids_file.exists() {
        return None;
    }

    let serialized_program_ids: HashMap<String, HexAndBase58ProgramIdArtifact> =
        serde_json::from_reader(File::open(program_ids_file).unwrap()).unwrap();

    let existing_program_ids = serialized_program_ids
        .iter()
        .map(|(chain_name, program_id)| (chain_name.clone(), program_id.into()))
        .collect::<HashMap<String, Pubkey>>();

    Some(existing_program_ids)
}
