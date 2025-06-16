use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_token_collateral::plugin::CollateralPlugin;
use hyperlane_sealevel_token_native::plugin::NativePlugin;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt::Debug,
    process::{Command, Stdio},
};

use solana_client::{
    client_error::{reqwest, ClientError},
    rpc_client::RpcClient,
};

use solana_sdk::{instruction::Instruction, program_error::ProgramError, pubkey::Pubkey};

use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_token::{
    hyperlane_token_mint_pda_seeds, plugin::SyntheticPlugin, spl_token_2022,
};
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{
        enroll_remote_routers_instruction, set_destination_gas_configs, set_igp_instruction,
        set_interchain_security_module_instruction, transfer_ownership_instruction, Init,
    },
};

use crate::{
    cmd_utils::account_exists,
    core::CoreProgramIds,
    registry::ChainMetadata,
    router::{
        deploy_routers, ConnectionClient, Ownable, RouterConfig, RouterConfigGetter, RouterDeployer,
    },
    Context, TokenType as FlatTokenType, WarpRouteCmd, WarpRouteSubCmd,
};

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SplTokenOffchainMetadata {
    name: String,
    symbol: String,
    description: Option<String>,
    image: Option<String>,
    website: Option<String>,
    // Array of key-value pairs
    attributes: Option<Vec<(String, String)>>,
}

impl SplTokenOffchainMetadata {
    fn validate(&self) {
        assert!(!self.name.is_empty(), "Name must not be empty");
        assert!(
            !self.symbol.is_empty(),
            "Symbol must not be empty for token with name: {}",
            self.name
        );
        assert!(
            self.description.is_some(),
            "Description must be provided for token with name: {}",
            self.name
        );
        assert!(
            self.image.is_some(),
            "Image must be provided for token with name: {}",
            self.name
        );
        let image_url = self.image.as_ref().unwrap();
        let image = reqwest::blocking::get(image_url).unwrap();
        assert!(
            image.status().is_success(),
            "Image URL must return a successful status code, url: {}",
            image_url,
        );
    }
}

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
    uri: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CollateralInfo {
    #[serde(rename = "token")]
    mint: String,
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
                deploy.registry,
                deploy.env_args.environments_dir,
                &deploy.env_args.environment,
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
        chain_metadata: &ChainMetadata,
        app_config: &TokenConfig,
        program_id: Pubkey,
    ) {
        let try_fund_ata_payer = |ctx: &mut Context, client: &RpcClient| {
            if let Some(ata_payer_funding_amount) = self.ata_payer_funding_amount {
                if matches!(
                    app_config.token_type,
                    TokenType::Collateral(_) | TokenType::Synthetic(_)
                ) {
                    fund_ata_payer_up_to(ctx, client, program_id, ata_payer_funding_amount);
                }
            }
        };

        let (token_pda, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);
        if account_exists(client, &token_pda).unwrap() {
            println!("Warp route token already exists, skipping init");

            // Fund the ATA payer up to the specified amount.
            try_fund_ata_payer(ctx, client);

            return;
        }

        let domain_id = chain_metadata.domain_id();

        // TODO: consider pulling the setting of defaults into router.rs,
        // and possibly have a more distinct connection client abstraction.

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

        let home_path = std::env::var("HOME").unwrap();
        let spl_token_binary_path = format!("{home_path}/.cargo/bin/spl-token");

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

                ctx.new_txn()
                    .add(
                        hyperlane_sealevel_token::instruction::init_instruction(
                            program_id,
                            ctx.payer_pubkey,
                            init,
                        )
                        .unwrap(),
                    )
                    .with_client(client)
                    .send_with_payer();

                let (mint_account, _mint_bump) =
                    Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);

                let mut cmd = Command::new(spl_token_binary_path.clone());
                cmd.args([
                    "create-token",
                    mint_account.to_string().as_str(),
                    "--enable-metadata",
                    "-p",
                    spl_token_2022::id().to_string().as_str(),
                    "--url",
                    client.url().as_str(),
                    "--with-compute-unit-limit",
                    "500000",
                    "--mint-authority",
                    &ctx.payer_pubkey.to_string(),
                    "--fee-payer",
                    ctx.payer_keypair_path(),
                ]);

                println!("running command: {:?}", cmd);
                let status = cmd
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status()
                    .expect("Failed to run command");

                println!("initialized metadata pointer. Status: {status}");

                ctx.new_txn().add(
                    spl_token_2022::instruction::initialize_mint2(
                        &spl_token_2022::id(),
                        &mint_account,
                        &ctx.payer_pubkey,
                        None,
                        decimals,
                    )
                    .unwrap(),
                )
            }
            TokenType::Collateral(collateral_info) => {
                let collateral_mint = collateral_info.mint.parse().expect("Invalid mint address");
                let collateral_mint_account = client.get_account(&collateral_mint).unwrap();
                // The owner of the mint account is the SPL Token program responsible for it
                // (either spl-token or spl-token-2022).
                let collateral_spl_token_program = collateral_mint_account.owner;

                ctx.new_txn().add(
                    hyperlane_sealevel_token_collateral::instruction::init_instruction(
                        program_id,
                        ctx.payer_pubkey,
                        init,
                        collateral_spl_token_program,
                        collateral_mint,
                    )
                    .unwrap(),
                )
            }
        }
        .with_client(client)
        .send_with_payer();

        if let TokenType::Synthetic(token_metadata) = &app_config.token_type {
            let (mint_account, _mint_bump) =
                Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);

            let mut cmd = Command::new(spl_token_binary_path.clone());
            cmd.args([
                "initialize-metadata",
                mint_account.to_string().as_str(),
                token_metadata.name.as_str(),
                token_metadata.symbol.as_str(),
                token_metadata.uri.as_deref().unwrap_or(""),
                "-p",
                spl_token_2022::id().to_string().as_str(),
                "--url",
                client.url().as_str(),
                "--with-compute-unit-limit",
                "500000",
                "--mint-authority",
                ctx.payer_keypair_path(),
                "--fee-payer",
                ctx.payer_keypair_path(),
                "--update-authority",
                &ctx.payer_pubkey.to_string(),
            ]);
            println!("running command: {:?}", cmd);
            let status = cmd
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .expect("Failed to run command");
            println!("initialized metadata. Status: {status}");

            // Move the mint authority to the mint account.
            // The deployer key will still hold the metadata pointer and metadata authorities.
            let authorities_to_transfer = &["mint"];

            for authority in authorities_to_transfer {
                println!("Transferring authority: {authority} to the mint account {mint_account}");

                let mut cmd = Command::new(spl_token_binary_path.clone());
                cmd.args([
                    "authorize",
                    mint_account.to_string().as_str(),
                    authority,
                    mint_account.to_string().as_str(),
                    "-p",
                    spl_token_2022::id().to_string().as_str(),
                    "--url",
                    client.url().as_str(),
                    "--with-compute-unit-limit",
                    "500000",
                    "--fee-payer",
                    ctx.payer_keypair_path(),
                    "--authority",
                    ctx.payer_keypair_path(),
                ]);
                println!("Running command: {:?}", cmd);
                let status = cmd
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status()
                    .expect("Failed to run command");
                println!("Set the {authority} authority to the mint account. Status: {status}");
            }
        }

        try_fund_ata_payer(ctx, client);
    }

    fn verify_config(
        &self,
        _ctx: &mut Context,
        _app_configs: &HashMap<String, TokenConfig>,
        app_configs_to_deploy: &HashMap<&String, &TokenConfig>,
        chain_metadatas: &HashMap<String, ChainMetadata>,
    ) {
        // We only have validations for SVM tokens at the moment.
        for (chain, config) in app_configs_to_deploy.iter() {
            if let TokenType::Synthetic(synthetic) = &config.token_type {
                // Verify that the metadata URI provided points to a valid JSON file.
                let metadata_uri = match synthetic.uri.as_ref() {
                    Some(uri) => uri,
                    None => {
                        if chain_metadatas
                            .get(*chain)
                            .unwrap()
                            .is_testnet
                            .unwrap_or(false)
                        {
                            // Skip validation for testnet chain
                            println!(
                                "Skipping metadata URI validation for testnet chain: {}",
                                chain
                            );
                            continue;
                        }
                        panic!("URI not provided for token: {}", chain);
                    }
                };
                println!("Validating metadata URI: {}", metadata_uri);
                let metadata_response = reqwest::blocking::get(metadata_uri).unwrap();
                let metadata_contents: SplTokenOffchainMetadata = metadata_response
                    .json()
                    .expect("Failed to parse metadata JSON");
                metadata_contents.validate();

                // Ensure that the metadata contents match the provided token config.
                assert_eq!(metadata_contents.name, synthetic.name, "Name mismatch");
                assert_eq!(
                    metadata_contents.symbol, synthetic.symbol,
                    "Symbol mismatch"
                );
            }
        }
    }

    /// Sets gas router configs on all deployable chains.
    fn post_deploy(
        &self,
        ctx: &mut Context,
        app_configs: &HashMap<String, TokenConfig>,
        app_configs_to_deploy: &HashMap<&String, &TokenConfig>,
        chain_metadatas: &HashMap<String, ChainMetadata>,
        routers: &HashMap<u32, H256>,
    ) {
        // Set gas amounts for each destination chain
        for chain_name in app_configs_to_deploy.keys() {
            let chain_metadata = chain_metadatas
                .get(*chain_name)
                .unwrap_or_else(|| panic!("Chain config not found for chain: {}", chain_name));

            let domain_id = chain_metadata.domain_id();
            let program_id: Pubkey =
                Pubkey::new_from_array(*routers.get(&domain_id).unwrap().as_fixed_bytes());

            // And set destination gas
            let configured_destination_gas =
                get_destination_gas(&chain_metadata.client(), &program_id).unwrap();

            let expected_destination_gas = app_configs
                .iter()
                // filter out local chain
                .filter(|(dest_chain_name, _)| dest_chain_name != chain_name)
                .map(|(dest_chain_name, app_config)| {
                    let domain = chain_metadatas.get(dest_chain_name).unwrap().domain_id();
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

            let owner = self.get_owner(&chain_metadata.client(), &program_id);

            if let Some(owner) = owner {
                if !destination_gas_configs.is_empty() {
                    let description = format!(
                    "Setting destination gas amounts for chain: {}, program_id {}, destination gas: {:?}",
                    chain_name, program_id, destination_gas_configs,
                );
                    ctx.new_txn()
                        .add_with_description(
                            set_destination_gas_configs(program_id, owner, destination_gas_configs)
                                .unwrap(),
                            description,
                        )
                        .with_client(&chain_metadata.client())
                        .send_with_pubkey_signer(&owner);
                } else {
                    println!(
                        "No destination gas amount changes for chain: {}, program_id {}",
                        chain_name, program_id
                    );
                }
            } else {
                println!(
                    "Cannot set destination gas amounts for chain: {}, program_id {} because owner is None",
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

    fn get_interchain_gas_paymaster(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<(Pubkey, InterchainGasPaymasterType)> {
        let token_data = get_token_data::<()>(client, program_id);

        token_data.interchain_gas_paymaster
    }

    fn set_interchain_gas_paymaster_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        igp_config: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) -> Option<Instruction> {
        let token_data = get_token_data::<()>(client, program_id);

        Some(set_igp_instruction(*program_id, token_data.owner.unwrap(), igp_config).unwrap())
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

pub fn install_spl_token_cli() {
    println!("Installing cargo 1.76.0 (required by spl-token-cli)");
    Command::new("rustup")
        .args(["toolchain", "install", "1.76.0"])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run command");
    println!("Installing the spl token cli");
    Command::new("cargo")
        .args([
            "+1.76.0",
            "install",
            "spl-token-cli",
            "--git",
            "https://github.com/hyperlane-xyz/solana-program-library",
            "--branch",
            "dan/create-token-for-mint",
            "--rev",
            "e101cca",
            "--locked",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run command");
}
