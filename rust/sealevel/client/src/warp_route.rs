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
use hyperlane_sealevel_token_memo::{
    hyperlane_token_ata_payer_pda_seeds as hyperlane_token_ata_payer_pda_seeds_memo,
    hyperlane_token_mint_pda_seeds as hyperlane_token_mint_pda_seeds_memo,
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

const MAX_LOCAL_DECIMALS: u8 = 9;

/// Creates a metadata pointer initialization instruction manually
/// This is needed because spl-token-2022 v0.5.0 doesn't have the metadata_pointer extension
/// (it was added in later versions, but the workspace is locked to Solana 1.14.13 which is incompatible with newer versions)
fn create_metadata_pointer_initialize_instruction(
    token_program_id: &Pubkey,
    mint: &Pubkey,
    authority: Option<Pubkey>,
    metadata_address: Option<Pubkey>,
) -> Instruction {
    // MetadataPointerExtension instruction discriminator
    // From spl-token-2022 v4.x: TokenInstruction::MetadataPointerExtension
    let token_instruction_discriminator: u8 = 39; // MetadataPointerExtension
    let metadata_pointer_instruction_discriminator: u8 = 0; // Initialize
    
    // Format: [token_instruction(1), metadata_pointer_instruction(1), InitializeInstructionData(64)]
    // InitializeInstructionData = authority(32 bytes) + metadata_address(32 bytes)
    // OptionalNonZeroPubkey is just a Pubkey (32 bytes) - None is represented as Pubkey::default() (all zeros)
    let mut data = vec![token_instruction_discriminator, metadata_pointer_instruction_discriminator];
    
    // Serialize authority as OptionalNonZeroPubkey (32 bytes - Pubkey::default() if None)
    let authority_bytes = authority.unwrap_or_default();
    data.extend_from_slice(authority_bytes.as_ref());
    
    // Serialize metadata_address as OptionalNonZeroPubkey (32 bytes - Pubkey::default() if None)
    let metadata_address_bytes = metadata_address.unwrap_or_default();
    data.extend_from_slice(metadata_address_bytes.as_ref());

    println!(
        "  - Metadata pointer instruction data_len={} bytes (manual implementation for Solana 1.14.13 compatibility)",
        data.len()
    );
    println!(
        "  - Authority: {} (is_some={})",
        authority_bytes,
        authority.is_some()
    );
    println!(
        "  - Metadata address: {} (is_some={})",
        metadata_address_bytes,
        metadata_address.is_some()
    );

    Instruction {
        program_id: *token_program_id,
        accounts: vec![solana_sdk::instruction::AccountMeta::new(*mint, false)],
        data,
    }
}

pub(crate) fn assert_decimals_max(decimals: u8) {
    assert!(
        decimals <= MAX_LOCAL_DECIMALS,
        "Invalid decimals: {}. Decimals must be <= {}. Use remoteDecimals instead.",
        decimals,
        MAX_LOCAL_DECIMALS
    );
}

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
    NativeMemo,
    Synthetic(TokenMetadata),
    SyntheticMemo(TokenMetadata),
    Collateral(CollateralInfo),
    CollateralMemo(CollateralInfo),
}

impl TokenType {
    // Borrowed from HypERC20Deployer's `gasOverheadDefault`.
    fn gas_overhead_default(&self) -> u64 {
        // TODO: note these are the amounts specific to the EVM.
        // We should eventually make this configurable per protocol type before we
        // enforce gas amounts to Sealevel chains.
        match &self {
            TokenType::Synthetic(_) => 64_000,
            TokenType::SyntheticMemo(_) => 64_000,
            TokenType::Native => 44_000,
            TokenType::NativeMemo => 44_000,
            TokenType::Collateral(_) => 68_000,
            TokenType::CollateralMemo(_) => 68_000,
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
            TokenType::NativeMemo => "hyperlane_sealevel_token_native_memo",
            TokenType::Synthetic(_) => "hyperlane_sealevel_token",
            TokenType::SyntheticMemo(_) => "hyperlane_sealevel_token_memo",
            TokenType::Collateral(_) => "hyperlane_sealevel_token_collateral",
            TokenType::CollateralMemo(_) => "hyperlane_sealevel_token_collateral_memo",
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
        // Enforce decimals limit
        assert_decimals_max(app_config.decimal_metadata.decimals);
        let try_fund_ata_payer = |ctx: &mut Context, client: &RpcClient| {
            if let Some(ata_payer_funding_amount) = self.ata_payer_funding_amount {
                if matches!(
                    app_config.token_type,
                    TokenType::Collateral(_)
                        | TokenType::CollateralMemo(_)
                        | TokenType::Synthetic(_)
                        | TokenType::SyntheticMemo(_)
                ) {
                    fund_ata_payer_up_to(
                        ctx,
                        client,
                        program_id,
                        &app_config.token_type,
                        ata_payer_funding_amount,
                    );
                }
            }
        };

        let (token_pda, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);
        
        // Check if token PDA exists and is initialized
        if account_exists(client, &token_pda).unwrap() {
            println!("Token PDA exists at: {}", token_pda);
            
            // For Synthetic/SyntheticMemo, also check if mint is initialized
            if matches!(
                app_config.token_type,
                TokenType::Synthetic(_) | TokenType::SyntheticMemo(_)
            ) {
                let mint_account = match &app_config.token_type {
                    TokenType::Synthetic(_) => {
                        let (mint, _) = Pubkey::find_program_address(
                            hyperlane_token_mint_pda_seeds!(),
                            &program_id,
                        );
                        mint
                    }
                    TokenType::SyntheticMemo(_) => {
                        let (mint, _) = Pubkey::find_program_address(
                            hyperlane_token_mint_pda_seeds_memo!(),
                            &program_id,
                        );
                        mint
                    }
                    _ => unreachable!(),
                };
                
                // Check if mint account exists and has the right owner
                match client.get_account(&mint_account) {
                    Ok(account) => {
                        if account.owner == spl_token_2022::id() && account.data.len() > 0 {
                            println!(
                                "Mint account fully initialized: {}\n\
                                 Owner: {}\n\
                                 Data length: {}\n\
                                 Skipping initialization.",
                                mint_account, account.owner, account.data.len()
                            );
                            try_fund_ata_payer(ctx, client);
                            return;
                        } else {
                            println!(
                                "⚠️  WARNING: Mint account exists but is not properly initialized!\n\
                                 Mint: {}\n\
                                 Owner: {} (expected: {})\n\
                                 Data length: {}\n\
                                 This suggests a previous deployment failed.\n\
                                 You may need to clean up and redeploy with a new program ID.",
                                mint_account,
                                account.owner,
                                spl_token_2022::id(),
                                account.data.len()
                            );
                            // Continue with initialization attempt
                        }
                    }
                    Err(_) => {
                        println!(
                            "⚠️  WARNING: Token PDA exists but mint account not found!\n\
                             This suggests a previous deployment failed.\n\
                             Mint account should be: {}\n\
                             Attempting to continue with initialization...",
                            mint_account
                        );
                        // Continue with initialization attempt
                    }
                }
            } else {
                // For Native/Collateral tokens, just checking token PDA is enough
                println!("Warp route token already exists, skipping init");
                try_fund_ata_payer(ctx, client);
                return;
            }
        }

        let domain_id = chain_metadata.domain_id;

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
            TokenType::NativeMemo => ctx.new_txn().add(
                hyperlane_sealevel_token_native_memo::instruction::init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    init,
                )
                .unwrap(),
            ),
            TokenType::Synthetic(_token_metadata) => {
                let decimals = init.decimals;

                let (mint_account, _mint_bump) =
                    Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);

                println!(
                    "=== Initializing Synthetic token atomically ===\n\
                     Program ID: {}\n\
                     Mint Account: {}\n\
                     Decimals: {}\n\
                     Payer: {}",
                    program_id, mint_account, decimals, ctx.payer_pubkey
                );

                // Create a single atomic transaction with all three operations:
                // 1. init_instruction (creates mint account + token PDA + dispatch authority)
                println!("Step 1: Creating init_instruction");
                let init_ix = hyperlane_sealevel_token::instruction::init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    init,
                )
                .unwrap();
                println!("  - Accounts: {}", init_ix.accounts.len());
                
                // 2. metadata pointer initialization (must happen before mint initialization)
                println!("Step 2: Creating metadata_pointer initialize instruction");
                let metadata_pointer_ix = create_metadata_pointer_initialize_instruction(
                    &spl_token_2022::id(),
                    &mint_account,
                    Some(ctx.payer_pubkey),
                    Some(mint_account),
                );
                println!(
                    "  - Metadata pointer: authority={}, metadata_address={}",
                    ctx.payer_pubkey, mint_account
                );
                
                // 3. initialize_mint2 (initializes the mint)
                println!("Step 3: Creating initialize_mint2 instruction");
                let init_mint_ix = spl_token_2022::instruction::initialize_mint2(
                    &spl_token_2022::id(),
                    &mint_account,
                    &ctx.payer_pubkey,
                    None,
                    decimals,
                )
                .unwrap();
                println!("  - Mint authority: {}", ctx.payer_pubkey);

                ctx.new_txn()
                    .add(init_ix)
                    .add(metadata_pointer_ix)
                    .add(init_mint_ix)
            }
            TokenType::SyntheticMemo(_token_metadata) => {
                let decimals = init.decimals;

                let (mint_account, _mint_bump) = Pubkey::find_program_address(
                    hyperlane_token_mint_pda_seeds_memo!(),
                    &program_id,
                );

                println!(
                    "=== Initializing SyntheticMemo token atomically ===\n\
                     Program ID: {}\n\
                     Mint Account: {}\n\
                     Decimals: {}\n\
                     Payer: {}",
                    program_id, mint_account, decimals, ctx.payer_pubkey
                );

                // Create a single atomic transaction with all three operations:
                // 1. init_instruction (creates mint account + token PDA + dispatch authority)
                println!("Step 1: Creating init_instruction");
                let init_ix = hyperlane_sealevel_token_memo::instruction::init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    init,
                )
                .unwrap();
                println!("  - Accounts: {}", init_ix.accounts.len());
                
                // 2. metadata pointer initialization (must happen before mint initialization)
                println!("Step 2: Creating metadata_pointer initialize instruction");
                let metadata_pointer_ix = create_metadata_pointer_initialize_instruction(
                    &spl_token_2022::id(),
                    &mint_account,
                    Some(ctx.payer_pubkey),
                    Some(mint_account),
                );
                println!(
                    "  - Metadata pointer: authority={}, metadata_address={}",
                    ctx.payer_pubkey, mint_account
                );
                
                // 3. initialize_mint2 (initializes the mint)
                println!("Step 3: Creating initialize_mint2 instruction");
                let init_mint_ix = spl_token_2022::instruction::initialize_mint2(
                    &spl_token_2022::id(),
                    &mint_account,
                    &ctx.payer_pubkey,
                    None,
                    decimals,
                )
                .unwrap();
                println!("  - Mint authority: {}", ctx.payer_pubkey);

                ctx.new_txn()
                    .add(init_ix)
                    .add(metadata_pointer_ix)
                    .add(init_mint_ix)
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
            TokenType::CollateralMemo(collateral_info) => {
                let collateral_mint = collateral_info.mint.parse().expect("Invalid mint address");
                let collateral_mint_account = client.get_account(&collateral_mint).unwrap();
                // The owner of the mint account is the SPL Token program responsible for it
                // (either spl-token or spl-token-2022).
                let collateral_spl_token_program = collateral_mint_account.owner;

                ctx.new_txn().add(
                    hyperlane_sealevel_token_collateral_memo::instruction::init_instruction(
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

        if matches!(
            &app_config.token_type,
            TokenType::Synthetic(_) | TokenType::SyntheticMemo(_)
        ) {
            let token_metadata = match &app_config.token_type {
                TokenType::Synthetic(metadata) | TokenType::SyntheticMemo(metadata) => metadata,
                _ => unreachable!(),
            };
            let (mint_account, _mint_bump) = match &app_config.token_type {
                TokenType::Synthetic(_) => {
                    Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id)
                }
                TokenType::SyntheticMemo(_) => Pubkey::find_program_address(
                    hyperlane_token_mint_pda_seeds_memo!(),
                    &program_id,
                ),
                _ => unreachable!(),
            };

            println!(
                "Initializing metadata for mint: {} with name: {}, symbol: {}, uri: {}",
                mint_account,
                token_metadata.name,
                token_metadata.symbol,
                token_metadata.uri.as_deref().unwrap_or("")
            );
            
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
            assert_decimals_max(config.decimal_metadata.decimals);
            if let TokenType::Synthetic(synthetic) | TokenType::SyntheticMemo(synthetic) =
                &config.token_type
            {
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

            let domain_id = chain_metadata.domain_id;
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
                    let domain = chain_metadatas.get(dest_chain_name).unwrap().domain_id;
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
    token_type: &TokenType,
    ata_payer_funding_amount: u64,
) {
    let (ata_payer_account, _ata_payer_bump) = match token_type {
        TokenType::Synthetic(_) | TokenType::Collateral(_) => Pubkey::find_program_address(
            hyperlane_sealevel_token::hyperlane_token_ata_payer_pda_seeds!(),
            &program_id,
        ),
        TokenType::SyntheticMemo(_) => {
            Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds_memo!(), &program_id)
        }
        TokenType::CollateralMemo(_) => Pubkey::find_program_address(
            hyperlane_sealevel_token_collateral_memo::hyperlane_token_ata_payer_pda_seeds!(),
            &program_id,
        ),
        _ => unreachable!("Native tokens don't have ATA payers"),
    };

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
        FlatTokenType::Native | FlatTokenType::NativeMemo => {
            let res = HyperlaneTokenAccount::<NativePlugin>::fetch(data);
            print_data_or_err(res);
        }
        FlatTokenType::Synthetic | FlatTokenType::SyntheticMemo => {
            let res = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(data);
            print_data_or_err(res);
        }
        FlatTokenType::Collateral | FlatTokenType::CollateralMemo => {
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
