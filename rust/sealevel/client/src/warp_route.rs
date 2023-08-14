use hyperlane_core::{utils::hex_or_base58_to_h256, H256};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::File, path::Path, str::FromStr};

use solana_client::{client_error::ClientError, rpc_client::RpcClient};
use solana_program::program_error::ProgramError;
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey, signature::Signer};

use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_token::{hyperlane_token_mint_pda_seeds, spl_token, spl_token_2022};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneTokenAccount,
    hyperlane_token_pda_seeds,
    instruction::{enroll_remote_routers_instruction, set_destination_gas_configs, Init},
};

use crate::{
    cmd_utils::{
        account_exists, create_and_write_keypair, create_new_directory, deploy_program_idempotent,
    },
    core::{read_core_program_ids, CoreProgramIds},
    Context, WarpRouteCmd, WarpRouteSubCmd,
};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DecimalMetadata {
    decimals: u8,
    remote_decimals: Option<u8>,
}

impl DecimalMetadata {
    fn remote_decimals(&self) -> u8 {
        self.remote_decimals.unwrap_or(self.decimals)
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TokenType {
    Native,
    Synthetic(TokenMetadata),
    Collateral(CollateralInfo),
}

impl TokenType {
    fn program_name(&self) -> &str {
        match self {
            TokenType::Native => "hyperlane_sealevel_token_native",
            TokenType::Synthetic(_) => "hyperlane_sealevel_token",
            TokenType::Collateral(_) => "hyperlane_sealevel_token_collateral",
        }
    }

    // Borrowed from HypERC20Deployer's `gasOverheadDefault`.
    fn gas_overhead_default(&self) -> u64 {
        // TODO: note these are the amounts specific to the EVM.
        // We should eventually make this configurable per protocol type before we
        // enforce gas amounts to Sealevel chains.
        match &self {
            TokenType::Synthetic(_) => 64_000,
            TokenType::Native => 44_000,
            TokenType::Collateral(_) => 68_000,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TokenMetadata {
    name: String,
    symbol: String,
    total_supply: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
enum SplTokenProgramType {
    Token,
    Token2022,
}

impl SplTokenProgramType {
    fn program_id(&self) -> Pubkey {
        match &self {
            SplTokenProgramType::Token => spl_token::id(),
            SplTokenProgramType::Token2022 => spl_token_2022::id(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CollateralInfo {
    #[serde(rename = "token")]
    mint: String,
    spl_token_program: Option<SplTokenProgramType>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InterchainGasPaymasterConfig {
    program_id: Pubkey,
    igp_account: InterchainGasPaymasterType,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OptionalConnectionClientConfig {
    mailbox: Option<String>,
    interchain_gas_paymaster: Option<InterchainGasPaymasterConfig>,
    interchain_security_module: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OptionalOwnableConfig {
    owner: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TokenConfig {
    #[serde(flatten)]
    token_type: TokenType,
    foreign_deployment: Option<String>,
    #[serde(flatten)]
    decimal_metadata: DecimalMetadata,
    #[serde(flatten)]
    ownable: OptionalOwnableConfig,
    #[serde(flatten)]
    connection_client: OptionalConnectionClientConfig,
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
    public_rpc_urls: Vec<RpcUrlConfig>,
}

impl ChainMetadata {
    fn client(&self) -> RpcClient {
        RpcClient::new_with_commitment(
            self.public_rpc_urls[0].http.clone(),
            CommitmentConfig::confirmed(),
        )
    }

    fn domain_id(&self) -> u32 {
        self.domain_id.unwrap_or(self.chain_id)
    }
}

pub(crate) fn process_warp_route_cmd(mut ctx: Context, cmd: WarpRouteCmd) {
    match cmd.cmd {
        WarpRouteSubCmd::Deploy(deploy) => {
            let token_config_file = File::open(deploy.token_config_file).unwrap();
            let token_configs: HashMap<String, TokenConfig> =
                serde_json::from_reader(token_config_file).unwrap();

            let chain_config_file = File::open(deploy.chain_config_file).unwrap();
            let chain_configs: HashMap<String, ChainMetadata> =
                serde_json::from_reader(chain_config_file).unwrap();

            let environments_dir =
                create_new_directory(&deploy.environments_dir, &deploy.environment);

            let artifacts_dir = create_new_directory(&environments_dir, "warp-routes");
            let warp_route_dir = create_new_directory(&artifacts_dir, &deploy.warp_route_name);
            let keys_dir = create_new_directory(&warp_route_dir, "keys");

            let foreign_deployments = token_configs
                .iter()
                .filter(|(_, token_config)| token_config.foreign_deployment.is_some())
                .map(|(chain_name, token_config)| {
                    let chain_config = chain_configs.get(chain_name).unwrap();
                    (
                        chain_config.domain_id(),
                        hex_or_base58_to_h256(token_config.foreign_deployment.as_ref().unwrap())
                            .unwrap(),
                    )
                })
                .collect::<HashMap<u32, H256>>();

            let mut routers: HashMap<u32, H256> = foreign_deployments;

            let token_configs_to_deploy = token_configs
                .clone()
                .into_iter()
                .filter(|(_, token_config)| token_config.foreign_deployment.is_none())
                .collect::<HashMap<_, _>>();

            // Deploy to chains that don't have a foreign deployment
            for (chain_name, token_config) in token_configs_to_deploy.iter() {
                let chain_config = chain_configs
                    .get(chain_name)
                    .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

                if token_config.ownable.owner.is_some() {
                    println!("WARNING: Ownership transfer is not yet supported in this deploy tooling, ownership is granted to the payer account");
                }

                let program_id = deploy_warp_route(
                    &mut ctx,
                    &keys_dir,
                    &deploy.environments_dir,
                    &deploy.environment,
                    &deploy.built_so_dir,
                    chain_config,
                    token_config,
                    deploy.ata_payer_funding_amount,
                );

                routers.insert(
                    chain_config.domain_id(),
                    H256::from_slice(&program_id.to_bytes()[..]),
                );
            }

            // Now enroll routers
            for (chain_name, _) in token_configs_to_deploy {
                let chain_config = chain_configs
                    .get(&chain_name)
                    .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

                let domain_id = chain_config.domain_id();
                let program_id: Pubkey =
                    Pubkey::new_from_array(*routers.get(&domain_id).unwrap().as_fixed_bytes());

                let enrolled_routers = get_routers(&chain_config.client(), &program_id).unwrap();

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
                        .add(
                            enroll_remote_routers_instruction(
                                program_id,
                                ctx.payer.pubkey(),
                                router_configs,
                            )
                            .unwrap(),
                        )
                        .with_client(&chain_config.client())
                        .send_with_payer();
                } else {
                    println!(
                        "No router changes for chain: {}, program_id {}",
                        chain_name, program_id
                    );
                }

                // And set destination gas
                let configured_destination_gas =
                    get_destination_gas(&chain_config.client(), &program_id).unwrap();

                let expected_destination_gas = token_configs
                    .iter()
                    // filter out local chain
                    .filter(|(dest_chain_name, _)| *dest_chain_name != &chain_name)
                    .map(|(dest_chain_name, token_config)| {
                        let domain = chain_configs.get(dest_chain_name).unwrap().domain_id();
                        (
                            domain,
                            GasRouterConfig {
                                domain,
                                gas: Some(token_config.token_type.gas_overhead_default()),
                            },
                        )
                    })
                    .collect::<HashMap<u32, GasRouterConfig>>();

                // Destination gas to set or update to a Some value
                let destination_gas_to_set = expected_destination_gas
                    .iter()
                    .filter(|(domain, expected_config)| {
                        configured_destination_gas.get(domain) != expected_config.gas.as_ref()
                    })
                    .map(|(_, expected_config)| expected_config.clone());

                // Destination gas to remove
                let destination_gas_to_unset = configured_destination_gas
                    .iter()
                    .filter(|(domain, _)| !expected_destination_gas.contains_key(domain))
                    .map(|(domain, _)| GasRouterConfig {
                        domain: *domain,
                        gas: None,
                    });

                // All destination gas config changes
                let destination_gas_configs = destination_gas_to_set
                    .chain(destination_gas_to_unset)
                    .collect::<Vec<GasRouterConfig>>();

                if !destination_gas_configs.is_empty() {
                    println!(
                        "Setting destination gas amounts for chain: {}, program_id {}, destination gas: {:?}",
                        chain_name, program_id, destination_gas_configs,
                    );

                    ctx.new_txn()
                        .add(
                            set_destination_gas_configs(
                                program_id,
                                ctx.payer.pubkey(),
                                destination_gas_configs,
                            )
                            .unwrap(),
                        )
                        .with_client(&chain_config.client())
                        .send_with_payer();
                } else {
                    println!(
                        "No destination gas amount changes for chain: {}, program_id {}",
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
            write_program_ids(&warp_route_dir, &routers_by_name);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn deploy_warp_route(
    ctx: &mut Context,
    key_dir: &Path,
    environments_dir: &Path,
    environment: &str,
    built_so_dir: &Path,
    chain_config: &ChainMetadata,
    token_config: &TokenConfig,
    ata_payer_funding_amount: Option<u64>,
) -> Pubkey {
    println!(
        "Attempting deploy on chain: {}\nToken config: {:?}",
        chain_config.name, token_config
    );

    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        format!(
            "{}-{}.json",
            token_config.token_type.program_name(),
            chain_config.name
        )
        .as_str(),
        true,
    );
    let program_id = keypair.pubkey();

    deploy_program_idempotent(
        &ctx.payer_path,
        &keypair,
        keypair_path.to_str().unwrap(),
        built_so_dir
            .join(format!("{}.so", token_config.token_type.program_name()))
            .to_str()
            .unwrap(),
        &chain_config.public_rpc_urls[0].http,
    )
    .unwrap();

    let core_program_ids = read_core_program_ids(environments_dir, environment, &chain_config.name);
    init_warp_route_idempotent(
        ctx,
        &chain_config.client(),
        &core_program_ids,
        chain_config,
        token_config,
        program_id,
        ata_payer_funding_amount,
    )
    .unwrap();

    match &token_config.token_type {
        TokenType::Native => {
            println!("Deploying native token");
        }
        TokenType::Synthetic(_token_metadata) => {
            println!("Deploying synthetic token");
        }
        TokenType::Collateral(_collateral_info) => {
            println!("Deploying collateral token");
        }
    }

    program_id
}

fn init_warp_route_idempotent(
    ctx: &mut Context,
    client: &RpcClient,
    core_program_ids: &CoreProgramIds,
    _chain_config: &ChainMetadata,
    token_config: &TokenConfig,
    program_id: Pubkey,
    ata_payer_funding_amount: Option<u64>,
) -> Result<(), ProgramError> {
    let (token_pda, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);

    if let Some(ata_payer_funding_amount) = ata_payer_funding_amount {
        if matches!(
            token_config.token_type,
            TokenType::Collateral(_) | TokenType::Synthetic(_)
        ) {
            fund_ata_payer_up_to(ctx, client, program_id, ata_payer_funding_amount);
        }
    }

    if account_exists(client, &token_pda).unwrap() {
        println!("Token PDA already exists, skipping init");
        return Ok(());
    }

    init_warp_route(
        ctx,
        client,
        core_program_ids,
        _chain_config,
        token_config,
        program_id,
    )
}

fn fund_ata_payer_up_to(
    ctx: &mut Context,
    client: &RpcClient,
    program_id: Pubkey,
    ata_payer_funding_amount: u64,
) {
    let (ata_payer_account, _ata_payer_bump) = Pubkey::find_program_address(
        hyperlane_sealevel_token::hyperlane_token_ata_payer_pda_seeds!(),
        &program_id,
    );

    let current_balance = client.get_balance(&ata_payer_account).unwrap();

    let funding_amount = ata_payer_funding_amount.saturating_sub(current_balance);

    if funding_amount == 0 {
        println!("ATA payer fully funded with balance of {}", current_balance);
        return;
    }

    println!(
        "Funding ATA payer {} with funding_amount {} to reach total balance of {}",
        ata_payer_account, funding_amount, ata_payer_funding_amount
    );
    ctx.new_txn()
        .add(solana_program::system_instruction::transfer(
            &ctx.payer.pubkey(),
            &ata_payer_account,
            funding_amount,
        ))
        .with_client(client)
        .send_with_payer();
}

fn init_warp_route(
    ctx: &mut Context,
    client: &RpcClient,
    core_program_ids: &CoreProgramIds,
    _chain_config: &ChainMetadata,
    token_config: &TokenConfig,
    program_id: Pubkey,
) -> Result<(), ProgramError> {
    // If the Mailbox was provided as configuration, use that. Otherwise, default to
    // the Mailbox found in the core program ids.
    let mailbox = token_config
        .connection_client
        .mailbox
        .as_ref()
        .map(|s| Pubkey::from_str(s).unwrap())
        .unwrap_or(core_program_ids.mailbox);

    // TODO for now not specifying an IGP for compatibility with the warp route UI.

    // let interchain_gas_paymaster = Some(token_config
    //     .connection_client
    //     .interchain_gas_paymaster
    //     .clone()
    //     .map(|config| (config.program_id, config.igp_account))
    //     .unwrap_or((
    //         core_program_ids.igp_program_id,
    //         InterchainGasPaymasterType::OverheadIgp(core_program_ids.overhead_igp_account),
    //     ))
    // );

    let interchain_gas_paymaster = None;

    let init = Init {
        mailbox,
        interchain_security_module: token_config
            .connection_client
            .interchain_security_module
            .as_ref()
            .map(|s| Pubkey::from_str(s).unwrap()),
        interchain_gas_paymaster,
        decimals: token_config.decimal_metadata.decimals,
        remote_decimals: token_config.decimal_metadata.remote_decimals(),
    };

    match &token_config.token_type {
        TokenType::Native => ctx.new_txn().add(
            hyperlane_sealevel_token_native::instruction::init_instruction(
                program_id,
                ctx.payer.pubkey(),
                init,
            )?,
        ),
        TokenType::Synthetic(_token_metadata) => {
            let decimals = init.decimals;

            let init_txn =
                ctx.new_txn()
                    .add(hyperlane_sealevel_token::instruction::init_instruction(
                        program_id,
                        ctx.payer.pubkey(),
                        init,
                    )?);

            let (mint_account, _mint_bump) =
                Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);
            // TODO: Also set Metaplex metadata?
            init_txn.add(
                spl_token_2022::instruction::initialize_mint2(
                    &spl_token_2022::id(),
                    &mint_account,
                    &mint_account,
                    None,
                    decimals,
                )
                .unwrap(),
            )
        }
        TokenType::Collateral(collateral_info) => ctx.new_txn().add(
            hyperlane_sealevel_token_collateral::instruction::init_instruction(
                program_id,
                ctx.payer.pubkey(),
                init,
                collateral_info
                    .spl_token_program
                    .as_ref()
                    .expect("Cannot initalize collateral warp route without SPL token program")
                    .program_id(),
                collateral_info.mint.parse().expect("Invalid mint address"),
            )?,
        ),
    }
    .with_client(client)
    .send_with_payer();

    Ok(())
}

fn get_routers(
    client: &RpcClient,
    token_program_id: &Pubkey,
) -> Result<HashMap<u32, H256>, ClientError> {
    let (token_pda, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), token_program_id);

    let account = client.get_account(&token_pda)?;
    let token_data = HyperlaneTokenAccount::<()>::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner();

    Ok(token_data.remote_routers)
}

fn get_destination_gas(
    client: &RpcClient,
    token_program_id: &Pubkey,
) -> Result<HashMap<u32, u64>, ClientError> {
    let (token_pda, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), token_program_id);

    let account = client.get_account(&token_pda)?;
    let token_data = HyperlaneTokenAccount::<()>::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner();

    Ok(token_data.destination_gas)
}

#[derive(Serialize, Deserialize)]
struct SerializedProgramId {
    hex: String,
    base58: String,
}

fn write_program_ids(warp_route_dir: &Path, routers: &HashMap<String, H256>) {
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

    let program_ids_file = warp_route_dir.join("program-ids.json");
    let program_ids_file = File::create(program_ids_file).unwrap();
    serde_json::to_writer_pretty(program_ids_file, &serialized_program_ids).unwrap();
}
