use hyperlane_core::H256;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::File, path::PathBuf, str::FromStr};

use solana_client::rpc_client::RpcClient;
use solana_program::program_error::ProgramError;
use solana_sdk::{pubkey::Pubkey, signature::Signer};

use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;

use hyperlane_sealevel_token::{hyperlane_token_mint_pda_seeds, spl_token, spl_token_2022};
use hyperlane_sealevel_token_lib::instruction::{enroll_remote_routers_instruction, Init};

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program},
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
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TokenMetadata {
    name: String,
    symbol: String,
    total_supply: String,
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
struct TokenConfig {
    #[serde(flatten)]
    token_type: TokenType,
    owner: String,
    mailbox: String,
    interchain_gas_paymaster: String,
    existing_deployment: Option<String>,
    #[serde(flatten)]
    decimal_metadata: DecimalMetadata,
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
        RpcClient::new(self.public_rpc_urls[0].http.clone())
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

            let mut program_ids: HashMap<String, String> = HashMap::new();
            let mut routers: HashMap<u32, H256> = HashMap::new();

            for (chain_name, token_config) in token_configs.iter() {
                let chain_config = chain_configs
                    .get(chain_name)
                    .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

                if let Some(existing_deployment) = &token_config.existing_deployment {
                    program_ids.insert(chain_name.clone(), existing_deployment.clone());

                    let existing_h256 = if existing_deployment.starts_with("0x") {
                        H256::from_str(existing_deployment).unwrap()
                    } else {
                        let pubkey = Pubkey::from_str(existing_deployment).unwrap();
                        H256::from_slice(&pubkey.to_bytes()[..])
                    };
                    routers.insert(chain_config.domain_id(), existing_h256);

                    println!(
                        "Skipping existing deployment on chain: {} at address {} ({})",
                        chain_name, existing_deployment, existing_h256,
                    );
                    continue;
                }

                let program_id = deploy_warp_route(
                    &mut ctx,
                    &keys_dir,
                    &warp_route_dir,
                    &deploy.environments_dir,
                    &deploy.environment,
                    &deploy.built_so_dir,
                    chain_config,
                    token_config,
                    deploy.ata_payer_funding_amount,
                );

                program_ids.insert(chain_name.clone(), program_id.to_string());
                routers.insert(
                    chain_config.domain_id(),
                    H256::from_slice(&program_id.to_bytes()[..]),
                );
            }

            // Now enroll routers
            for (chain_name, token_config) in token_configs {
                if token_config.existing_deployment.is_some() {
                    continue;
                }

                let chain_config = chain_configs
                    .get(&chain_name)
                    .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

                let domain_id = chain_config.domain_id();

                let routers_to_enroll = routers
                    .iter()
                    .filter(|(router_domain_id, _)| *router_domain_id != &domain_id)
                    .map(|(domain, router)| RemoteRouterConfig {
                        domain: *domain,
                        router: Some(*router),
                    })
                    .collect::<Vec<RemoteRouterConfig>>();

                let program_id: Pubkey = program_ids.get(&chain_name).unwrap().parse().unwrap();

                println!(
                    "Enrolling routers for chain: {}, program_id {}, routers: {:?}",
                    chain_name, program_id, routers_to_enroll
                );

                ctx.instructions.push(
                    enroll_remote_routers_instruction(
                        program_id,
                        ctx.payer.pubkey(),
                        routers_to_enroll,
                    )
                    .unwrap(),
                );
                ctx.send_transaction(&[&ctx.payer]);
                ctx.instructions.clear();
            }

            write_program_ids(&warp_route_dir, program_ids);
        }
    }
}

fn deploy_warp_route(
    ctx: &mut Context,
    key_dir: &PathBuf,
    _warp_route_dir: &PathBuf,
    environments_dir: &PathBuf,
    environment: &str,
    built_so_dir: &PathBuf,
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

    deploy_program(
        &ctx.payer,
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        built_so_dir
            .join(format!("{}.so", token_config.token_type.program_name()))
            .to_str()
            .unwrap(),
        &chain_config.public_rpc_urls[0].http,
        // Not used
        "/",
    );

    let core_program_ids = read_core_program_ids(environments_dir, environment, &chain_config.name);
    init_warp_route(
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

fn init_warp_route(
    ctx: &mut Context,
    _client: &RpcClient,
    core_program_ids: &CoreProgramIds,
    _chain_config: &ChainMetadata,
    token_config: &TokenConfig,
    program_id: Pubkey,
    ata_payer_funding_amount: Option<u64>,
) -> Result<(), ProgramError> {
    let init = Init {
        mailbox: core_program_ids.mailbox,
        // TODO take in as arg?
        interchain_security_module: None,
        decimals: token_config.decimal_metadata.decimals,
        remote_decimals: token_config.decimal_metadata.remote_decimals(),
    };

    let mut init_instructions = match &token_config.token_type {
        TokenType::Native => vec![
            hyperlane_sealevel_token_native::instruction::init_instruction(
                program_id,
                ctx.payer.pubkey(),
                init,
            )?,
        ],
        TokenType::Synthetic(_token_metadata) => {
            let decimals = init.decimals;

            let mut instructions = vec![hyperlane_sealevel_token::instruction::init_instruction(
                program_id,
                ctx.payer.pubkey(),
                init,
            )?];

            let (mint_account, _mint_bump) =
                Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);
            // TODO: Also set Metaplex metadata?
            instructions.push(
                spl_token_2022::instruction::initialize_mint2(
                    &spl_token_2022::id(),
                    &mint_account,
                    &mint_account,
                    None,
                    decimals,
                )
                .unwrap(),
            );

            if let Some(ata_payer_funding_amount) = ata_payer_funding_amount {
                let (ata_payer_account, _ata_payer_bump) = Pubkey::find_program_address(
                    hyperlane_sealevel_token::hyperlane_token_ata_payer_pda_seeds!(),
                    &program_id,
                );
                instructions.push(solana_program::system_instruction::transfer(
                    &ctx.payer.pubkey(),
                    &ata_payer_account,
                    ata_payer_funding_amount,
                ));
            }

            instructions
        }
        TokenType::Collateral(collateral_info) => {
            let mut instructions = vec![
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
            ];

            if let Some(ata_payer_funding_amount) = ata_payer_funding_amount {
                let (ata_payer_account, _ata_payer_bump) = Pubkey::find_program_address(
                    hyperlane_sealevel_token_collateral::hyperlane_token_ata_payer_pda_seeds!(),
                    &program_id,
                );
                instructions.push(solana_program::system_instruction::transfer(
                    &ctx.payer.pubkey(),
                    &ata_payer_account,
                    ata_payer_funding_amount,
                ));
            }

            instructions
        }
    };

    ctx.instructions.append(&mut init_instructions);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    Ok(())
}

fn write_program_ids(warp_route_dir: &PathBuf, pretty_program_ids: HashMap<String, String>) {
    let program_ids_file = warp_route_dir.join("program-ids.json");
    let program_ids_file = File::create(program_ids_file).unwrap();
    serde_json::to_writer_pretty(program_ids_file, &pretty_program_ids).unwrap();
}
