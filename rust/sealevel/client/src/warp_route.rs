use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_token_collateral::plugin::CollateralPlugin;
use hyperlane_sealevel_token_native::plugin::NativePlugin;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fmt::Debug};

use solana_client::{client_error::ClientError, rpc_client::RpcClient};

use solana_sdk::{instruction::Instruction, program_error::ProgramError, pubkey::Pubkey};

use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_token::{
    hyperlane_token_mint_pda_seeds, plugin::SyntheticPlugin, spl_token, spl_token_2022,
};
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{
        enroll_remote_routers_instruction, set_destination_gas_configs,
        set_interchain_security_module_instruction, transfer_ownership_instruction, Init,
    },
};

use crate::{
    cmd_utils::account_exists,
    core::CoreProgramIds,
    router::{
        deploy_routers, ChainMetadata, ConnectionClient, Ownable, RouterConfig, RouterConfigGetter,
        RouterDeployer,
    },
    Context, TokenType as FlatTokenType, WarpRouteCmd, WarpRouteSubCmd,
};

/// Configuration relating to decimals.
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

/// Configuration relating to a Warp Route token.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TokenType {
    Native,
    Synthetic(TokenMetadata),
    Collateral(CollateralInfo),
}

impl TokenType {
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
struct TokenConfig {
    #[serde(flatten)]
    token_type: TokenType,
    #[serde(flatten)]
    decimal_metadata: DecimalMetadata,
    #[serde(flatten)]
    router_config: RouterConfig,
}

pub(crate) fn process_warp_route_cmd(mut ctx: Context, cmd: WarpRouteCmd) {
    match cmd.cmd {
        WarpRouteSubCmd::Deploy(deploy) => {
            deploy_routers(
                &mut ctx,
                WarpRouteDeployer::new(deploy.ata_payer_funding_amount),
                "warp-routes",
                &deploy.warp_route_name,
                deploy.token_config_file,
                deploy.chain_config_file,
                deploy.environments_dir,
                &deploy.environment,
                deploy.built_so_dir,
            );
        }
        WarpRouteSubCmd::DestinationGas(args) => {
            let destination_gas = get_destination_gas(&ctx.client, &args.program_id).unwrap();
            println!(
                "Destination gas: {:?}",
                destination_gas[&args.destination_domain]
            );
        }
    }
}

struct WarpRouteDeployer {
    ata_payer_funding_amount: Option<u64>,
}

impl WarpRouteDeployer {
    fn new(ata_payer_funding_amount: Option<u64>) -> Self {
        Self {
            ata_payer_funding_amount,
        }
    }
}

impl WarpRouteDeployer {}

impl RouterDeployer<TokenConfig> for WarpRouteDeployer {
    fn program_name(&self, config: &TokenConfig) -> &str {
        match config.token_type {
            TokenType::Native => "hyperlane_sealevel_token_native",
            TokenType::Synthetic(_) => "hyperlane_sealevel_token",
            TokenType::Collateral(_) => "hyperlane_sealevel_token_collateral",
        }
    }

    fn enroll_remote_routers_instruction(
        &self,
        program_id: Pubkey,
        payer: Pubkey,
        router_configs: Vec<RemoteRouterConfig>,
    ) -> Instruction {
        enroll_remote_routers_instruction(program_id, payer, router_configs).unwrap()
    }

    fn get_routers(&self, client: &RpcClient, program_id: &Pubkey) -> HashMap<u32, H256> {
        let token_data = get_token_data::<()>(client, program_id);

        token_data.remote_routers
    }

    fn init_program_idempotent(
        &self,
        ctx: &mut Context,
        client: &RpcClient,
        core_program_ids: &CoreProgramIds,
        chain_config: &ChainMetadata,
        app_config: &TokenConfig,
        program_id: Pubkey,
    ) {
        if let Some(ata_payer_funding_amount) = self.ata_payer_funding_amount {
            if matches!(
                app_config.token_type,
                TokenType::Collateral(_) | TokenType::Synthetic(_)
            ) {
                fund_ata_payer_up_to(ctx, client, program_id, ata_payer_funding_amount);
            }
        }

        let (token_pda, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);
        if account_exists(client, &token_pda).unwrap() {
            println!("Warp route token already exists, skipping init");
            return;
        }

        let domain_id = chain_config.domain_id();

        // TODO: consider pulling the setting of defaults into router.rs,
        // and possibly have a more distinct connection client abstration.

        let mailbox = app_config
            .router_config()
            .connection_client
            .mailbox(core_program_ids.mailbox);
        let interchain_security_module = app_config
            .router_config()
            .connection_client
            .interchain_security_module();
        let owner = Some(app_config.router_config().ownable.owner(ctx.payer_pubkey));

        // Default to the Overhead IGP
        let interchain_gas_paymaster = Some(
            app_config
                .router_config()
                .connection_client
                .interchain_gas_paymaster_config(client)
                .unwrap_or((
                    core_program_ids.igp_program_id,
                    InterchainGasPaymasterType::OverheadIgp(core_program_ids.overhead_igp_account),
                )),
        );

        println!(
            "Initializing Warp Route program: domain_id: {}, mailbox: {}, ism: {:?}, owner: {:?}, igp: {:?}",
            domain_id, mailbox, interchain_security_module, owner, interchain_gas_paymaster
        );

        let init = Init {
            mailbox,
            interchain_security_module,
            interchain_gas_paymaster,
            decimals: app_config.decimal_metadata.decimals,
            remote_decimals: app_config.decimal_metadata.remote_decimals(),
        };

        match &app_config.token_type {
            TokenType::Native => ctx.new_txn().add(
                hyperlane_sealevel_token_native::instruction::init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    init,
                )
                .unwrap(),
            ),
            TokenType::Synthetic(_token_metadata) => {
                let decimals = init.decimals;

                let init_txn = ctx.new_txn().add(
                    hyperlane_sealevel_token::instruction::init_instruction(
                        program_id,
                        ctx.payer_pubkey,
                        init,
                    )
                    .unwrap(),
                );

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
                    ctx.payer_pubkey,
                    init,
                    collateral_info
                        .spl_token_program
                        .as_ref()
                        .expect("Cannot initalize collateral warp route without SPL token program")
                        .program_id(),
                    collateral_info.mint.parse().expect("Invalid mint address"),
                )
                .unwrap(),
            ),
        }
        .with_client(client)
        .send_with_payer();
    }

    /// Sets gas router configs on all deployable chains.
    fn post_deploy(
        &self,
        ctx: &mut Context,
        app_configs: &HashMap<String, TokenConfig>,
        app_configs_to_deploy: &HashMap<&String, &TokenConfig>,
        chain_configs: &HashMap<String, ChainMetadata>,
        routers: &HashMap<u32, H256>,
    ) {
        // Set gas amounts for each destination chain
        for chain_name in app_configs_to_deploy.keys() {
            let chain_config = chain_configs
                .get(*chain_name)
                .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

            let domain_id = chain_config.domain_id();
            let program_id: Pubkey =
                Pubkey::new_from_array(*routers.get(&domain_id).unwrap().as_fixed_bytes());

            // And set destination gas
            let configured_destination_gas =
                get_destination_gas(&chain_config.client(), &program_id).unwrap();

            let expected_destination_gas = app_configs
                .iter()
                // filter out local chain
                .filter(|(dest_chain_name, _)| dest_chain_name != chain_name)
                .map(|(dest_chain_name, app_config)| {
                    let domain = chain_configs.get(dest_chain_name).unwrap().domain_id();
                    (
                        domain,
                        GasRouterConfig {
                            domain,
                            gas: Some(app_config.token_type.gas_overhead_default()),
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
                let description = format!(
                    "Setting destination gas amounts for chain: {}, program_id {}, destination gas: {:?}",
                    chain_name, program_id, destination_gas_configs,
                );
                ctx.new_txn()
                    .add_with_description(
                        set_destination_gas_configs(
                            program_id,
                            ctx.payer_pubkey,
                            destination_gas_configs,
                        )
                        .unwrap(),
                        description,
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
    }
}

impl RouterConfigGetter for TokenConfig {
    fn router_config(&self) -> &RouterConfig {
        &self.router_config
    }
}

impl Ownable for WarpRouteDeployer {
    /// Gets the owner configured on-chain.
    fn get_owner(&self, client: &RpcClient, program_id: &Pubkey) -> Option<Pubkey> {
        let token = get_token_data::<()>(client, program_id);

        token.owner
    }

    /// Gets an instruction to set the owner.
    fn set_owner_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        new_owner: Option<Pubkey>,
    ) -> Instruction {
        let token = get_token_data::<()>(client, program_id);

        transfer_ownership_instruction(*program_id, token.owner.unwrap(), new_owner).unwrap()
    }
}

impl ConnectionClient for WarpRouteDeployer {
    fn get_interchain_security_module(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<Pubkey> {
        let token_data = get_token_data::<()>(client, program_id);

        token_data.interchain_security_module
    }

    fn set_interchain_security_module_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        ism: Option<Pubkey>,
    ) -> Instruction {
        let token_data = get_token_data::<()>(client, program_id);

        set_interchain_security_module_instruction(*program_id, token_data.owner.unwrap(), ism)
            .unwrap()
    }
}

fn get_token_data<T>(client: &RpcClient, program_id: &Pubkey) -> HyperlaneToken<T>
where
    T: BorshDeserialize + BorshSerialize + Default + account_utils::Data,
{
    let (token_pda, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

    let account = client.get_account(&token_pda).unwrap();
    *HyperlaneTokenAccount::<T>::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
}

fn get_destination_gas(
    client: &RpcClient,
    program_id: &Pubkey,
) -> Result<HashMap<u32, u64>, ClientError> {
    let token_data = get_token_data::<()>(client, program_id);

    Ok(token_data.destination_gas)
}

// Funds the ATA payer up to the specified amount.
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

    ctx.new_txn()
        .add_with_description(
            solana_program::system_instruction::transfer(
                &ctx.payer_pubkey,
                &ata_payer_account,
                funding_amount,
            ),
            format!(
                "Funding ATA payer {} with funding_amount {} to reach total balance of {}",
                ata_payer_account, funding_amount, ata_payer_funding_amount
            ),
        )
        .with_client(client)
        .send_with_payer();
}

pub fn parse_token_account_data(token_type: FlatTokenType, data: &mut &[u8]) {
    fn print_data_or_err<T: Debug>(data: Result<T, ProgramError>) {
        match data {
            Ok(data) => println!("{:#?}", data),
            Err(err) => println!("Failed to deserialize account data: {}", err),
        }
    }

    match token_type {
        FlatTokenType::Native => {
            let res = HyperlaneTokenAccount::<NativePlugin>::fetch(data);
            print_data_or_err(res);
        }
        FlatTokenType::Synthetic => {
            let res = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(data);
            print_data_or_err(res);
        }
        FlatTokenType::Collateral => {
            let res = HyperlaneTokenAccount::<CollateralPlugin>::fetch(data);
            print_data_or_err(res);
        }
    }
}
