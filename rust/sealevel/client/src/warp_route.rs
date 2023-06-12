use clap::ValueEnum;
use hyperlane_core::{H160, H256};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::File, path::PathBuf};

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program},
    Context, WarpRouteCmd, WarpRouteDeploy, WarpRouteSubCmd,
};

// {
//     "goerli": {
//       "type": "collateral",
//       "token": "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6",
//       "owner": "0x5bA371aeA18734Cb7195650aFdfCa4f9251aa513",
//       "mailbox": "0xCC737a94FecaeC165AbCf12dED095BB13F037685",
//       "interchainGasPaymaster": "0xF90cB82a76492614D07B82a7658917f3aC811Ac1"
//     },
//     "alfajores": {
//       "type": "synthetic",
//       "owner": "0x5bA371aeA18734Cb7195650aFdfCa4f9251aa513",
//       "mailbox": "0xCC737a94FecaeC165AbCf12dED095BB13F037685",
//       "interchainGasPaymaster": "0xF90cB82a76492614D07B82a7658917f3aC811Ac1"
//     },
//     "fuji": {
//       "type": "synthetic",
//       "owner": "0x5bA371aeA18734Cb7195650aFdfCa4f9251aa513",
//       "mailbox": "0xCC737a94FecaeC165AbCf12dED095BB13F037685",
//       "interchainGasPaymaster": "0xF90cB82a76492614D07B82a7658917f3aC811Ac1"
//     },
//     "moonbasealpha": {
//       "type": "synthetic",
//       "owner": "0x5bA371aeA18734Cb7195650aFdfCa4f9251aa513",
//       "mailbox": "0xCC737a94FecaeC165AbCf12dED095BB13F037685",
//       "interchainGasPaymaster": "0xF90cB82a76492614D07B82a7658917f3aC811Ac1"
//     }
//   }

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DecimalMetadata {
    decimals: u8,
    remote_decimals: Option<u8>,
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
struct CollateralInfo {
    #[serde(rename = "token")]
    mint: String,
    spl_token_program: Option<String>,
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
}

impl ChainMetadata {
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

            for (chain_name, token_config) in token_configs {
                if token_config.existing_deployment.is_some() {
                    println!("Skipping existing deployment on chain: {}", chain_name);
                    continue;
                }

                let chain_config = chain_configs
                    .get(&chain_name)
                    .expect(format!("Chain config not found for chain: {}", chain_name).as_str());

                deploy_warp_route(
                    &mut ctx,
                    &keys_dir,
                    &warp_route_dir,
                    &deploy.built_so_dir,
                    chain_config,
                    &token_config,
                );
            }
        }
    }
}

fn deploy_warp_route(
    ctx: &mut Context,
    key_dir: &PathBuf,
    warp_route_dir: &PathBuf,
    built_so_dir: &PathBuf,
    chain_config: &ChainMetadata,
    token_config: &TokenConfig,
) {
    println!(
        "Attempting deploy on chain: {}\nToken config: {:?}",
        chain_config.name, token_config
    );

    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        format!("{}-keypair.json", token_config.token_type.program_name()).as_str(),
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

    match &token_config.token_type {
        TokenType::Native => {
            println!("Deploying native token");
        }
        TokenType::Synthetic(token_metadata) => {
            println!("Deploying synthetic token");
        }
        TokenType::Collateral(collateral_info) => {
            println!("Deploying collateral token");
        }
    }
}

fn init_warp_route(
    ctx: &mut Context,
    client: &RpcClient,
    chain_config: &ChainMetadata,
    token_config: &TokenConfig,
) {
    // let init_instructions = match &token_config.token_type {
    //     TokenType::Native => {
    //         hyperlane_sealevel_token_native::instruction::init_instruction(

    //         )
    //     }
    //     TokenType::Synthetic(token_metadata) => {
    //         println!("Deploying synthetic token");
    //     }
    //     TokenType::Collateral(collateral_info) => {
    //         println!("Deploying collateral token");
    //     }
    // };
}
