use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{
    artifacts::{read_json, try_read_json, write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    read_core_program_ids,
    router::ChainMetadata,
    Context, GasOverheadSubCmd, GetSetCmd, IgpCmd, IgpSubCmd,
};

use std::{path::Path, str::FromStr};

use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer as _},
};

use hyperlane_core::{KnownHyperlaneDomain, H256};

use hyperlane_sealevel_igp::{
    accounts::{
        GasOracle, GasPaymentAccount, IgpAccount, InterchainGasPaymasterType, OverheadIgpAccount,
        ProgramDataAccount as IgpProgramDataAccount, RemoteGasData,
    },
    igp_program_data_pda_seeds,
    instruction::{GasOracleConfig, GasOverheadConfig},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// Compatible with the format of our TS-generated configs.
struct GasOracleConfigWithOverhead {
    oracle_config: RemoteGasData,
    overhead: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct IgpAccountsArtifacts {
    salt: H256,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    igp_account: Option<Pubkey>,
    #[serde(default)]
    #[serde(with = "crate::serde::serde_option_pubkey")]
    overhead_igp_account: Option<Pubkey>,
}

fn get_context_salt(context: Option<&String>) -> H256 {
    context
        .map(|c| {
            if c == "default" {
                H256::zero()
            } else {
                ethers::utils::keccak256(c.as_bytes()).into()
            }
        })
        .unwrap_or_else(H256::zero)
}

fn get_context_dir_name(context: Option<&String>) -> &str {
    context.map(|c| c.as_str()).unwrap_or("default")
}

pub(crate) fn process_igp_cmd(mut ctx: Context, cmd: IgpCmd) {
    match cmd.cmd {
        IgpSubCmd::DeployProgram(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "igp");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let key_dir = create_new_directory(&chain_dir, "keys");
            let local_domain = deploy
                .chain
                .parse::<KnownHyperlaneDomain>()
                .map(|v| v as u32)
                .expect("Invalid chain name");

            let program_id =
                deploy_igp_program(&mut ctx, &deploy.built_so_dir, &key_dir, local_domain);

            write_json::<SingularProgramIdArtifact>(
                &chain_dir.join("program-ids.json"),
                program_id.into(),
            );
        }
        IgpSubCmd::InitIgpAccount(init) => {
            let environments_dir =
                create_new_directory(&init.env_args.environments_dir, &init.env_args.environment);
            let ism_dir = create_new_directory(&environments_dir, "igp");
            let chain_dir = create_new_directory(&ism_dir, &init.chain);
            let context_dir =
                create_new_directory(&chain_dir, get_context_dir_name(init.context.as_ref()));

            let artifacts_path = if init.account_salt.is_some() {
                context_dir.join(format!(
                    "igp-accounts-{}.json",
                    init.account_salt.clone().unwrap()
                ))
            } else {
                context_dir.join("igp-accounts.json")
            };

            let existing_artifacts = try_read_json::<IgpAccountsArtifacts>(&artifacts_path).ok();

            let salt = init
                .account_salt
                .map(|s| {
                    let salt_str = s.trim_start_matches("0x");
                    H256::from_str(salt_str).expect("Invalid salt format")
                })
                .unwrap_or_else(|| get_context_salt(init.context.as_ref()));

            let igp_account = init_igp_account(&mut ctx, init.program_id, salt);

            let artifacts = IgpAccountsArtifacts {
                salt,
                igp_account: Some(igp_account),
                overhead_igp_account: existing_artifacts.and_then(|a| a.overhead_igp_account),
            };

            write_json(&artifacts_path, artifacts);
        }
        IgpSubCmd::InitOverheadIgpAccount(init) => {
            let environments_dir =
                create_new_directory(&init.env_args.environments_dir, &init.env_args.environment);
            let ism_dir = create_new_directory(&environments_dir, "igp");
            let chain_dir = create_new_directory(&ism_dir, &init.chain);
            let context_dir =
                create_new_directory(&chain_dir, get_context_dir_name(init.context.as_ref()));

            let artifacts_path = if init.account_salt.is_some() {
                context_dir.join(format!(
                    "igp-accounts-{}.json",
                    init.account_salt.clone().unwrap()
                ))
            } else {
                context_dir.join("igp-accounts.json")
            };

            let existing_artifacts = try_read_json::<IgpAccountsArtifacts>(&artifacts_path).ok();

            let salt = init
                .account_salt
                .map(|s| {
                    let salt_str = s.trim_start_matches("0x");
                    H256::from_str(salt_str).expect("Invalid salt format")
                })
                .unwrap_or_else(|| get_context_salt(init.context.as_ref()));

            let overhead_igp_account =
                init_overhead_igp_account(&mut ctx, init.program_id, init.inner_igp_account, salt);

            let artifacts = IgpAccountsArtifacts {
                salt,
                igp_account: existing_artifacts.and_then(|a| a.igp_account),
                overhead_igp_account: Some(overhead_igp_account),
            };

            write_json(&artifacts_path, artifacts);
        }
        IgpSubCmd::Query(query) => {
            let (program_data_account_pda, _program_data_account_bump) =
                Pubkey::find_program_address(igp_program_data_pda_seeds!(), &query.program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(
                    &[program_data_account_pda, query.igp_account],
                    ctx.commitment,
                )
                .unwrap()
                .value;

            let igp_program_data =
                IgpProgramDataAccount::fetch(&mut &accounts[0].as_ref().unwrap().data[..])
                    .unwrap()
                    .into_inner();

            println!("IGP program data: {:?}", igp_program_data);

            let igp = IgpAccount::fetch(&mut &accounts[1].as_ref().unwrap().data[..])
                .unwrap()
                .into_inner();

            println!("IGP account: {:?}", igp);

            if let Some(gas_payment_account_pubkey) = query.gas_payment_account {
                let account = ctx
                    .client
                    .get_account_with_commitment(&gas_payment_account_pubkey, ctx.commitment)
                    .unwrap()
                    .value
                    .unwrap();
                let gas_payment_account = GasPaymentAccount::fetch(&mut &account.data[..])
                    .unwrap()
                    .into_inner();
                println!("Gas payment account: {:?}", gas_payment_account);
            }
        }
        IgpSubCmd::PayForGas(payment_details) => {
            let unique_gas_payment_keypair = Keypair::new();

            let salt = payment_details
                .account_salt
                .map(|s| {
                    let salt_str = s.trim_start_matches("0x");
                    H256::from_str(salt_str).expect("Invalid salt format")
                })
                .unwrap_or_else(H256::zero);

            let (igp_account, _igp_account_bump) = Pubkey::find_program_address(
                hyperlane_sealevel_igp::igp_pda_seeds!(salt),
                &payment_details.program_id,
            );

            let (overhead_igp_account, _) = Pubkey::find_program_address(
                hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
                &payment_details.program_id,
            );
            let (ixn, gas_payment_data_account) =
                hyperlane_sealevel_igp::instruction::pay_for_gas_instruction(
                    payment_details.program_id,
                    ctx.payer_pubkey,
                    igp_account,
                    Some(overhead_igp_account),
                    unique_gas_payment_keypair.pubkey(),
                    H256::from_str(&payment_details.message_id).unwrap(),
                    payment_details.destination_domain,
                    payment_details.gas,
                )
                .unwrap();

            ctx.new_txn().add(ixn).send(&[
                ctx.payer_signer().as_deref(),
                Some(&unique_gas_payment_keypair),
            ]);

            println!(
                "Made a payment for message {} with gas payment data account {}",
                payment_details.message_id, gas_payment_data_account
            );
        }
        IgpSubCmd::Claim(claim) => {
            let igp_account = ctx
                .client
                .get_account_with_commitment(&claim.igp_account, ctx.commitment)
                .unwrap()
                .value
                .unwrap();
            let igp_account = IgpAccount::fetch(&mut &igp_account.data[..])
                .unwrap()
                .into_inner();

            let ixn = hyperlane_sealevel_igp::instruction::claim_instruction(
                claim.program_id,
                claim.igp_account,
                igp_account.beneficiary,
            )
            .unwrap();

            ctx.new_txn()
                .add_with_description(
                    ixn,
                    format!(
                        "Claiming from IGP account {} to beneficiary {}",
                        claim.igp_account, igp_account.beneficiary
                    ),
                )
                .send_with_payer();
        }
        IgpSubCmd::SetIgpBeneficiary(set_beneficiary) => {
            let igp_account = ctx
                .client
                .get_account_with_commitment(&set_beneficiary.igp_account, ctx.commitment)
                .unwrap()
                .value
                .unwrap();
            let igp_account = IgpAccount::fetch(&mut &igp_account.data[..])
                .unwrap()
                .into_inner();

            let ixn = hyperlane_sealevel_igp::instruction::set_beneficiary_instruction(
                set_beneficiary.program_id,
                set_beneficiary.igp_account,
                igp_account.owner.unwrap(),
                set_beneficiary.new_beneficiary,
            )
            .unwrap();

            ctx.new_txn()
                .add_with_description(
                    ixn,
                    format!(
                        "Change beneficiary of IGP account {} to beneficiary {}",
                        set_beneficiary.igp_account, set_beneficiary.new_beneficiary
                    ),
                )
                .send_with_payer();
        }
        IgpSubCmd::GasOracleConfig(args) => {
            let core_program_ids = read_core_program_ids(
                &args.env_args.environments_dir,
                &args.env_args.environment,
                &args.chain_name,
            );
            match args.cmd {
                GetSetCmd::Set(set_args) => {
                    let remote_gas_data = RemoteGasData {
                        token_exchange_rate: set_args.token_exchange_rate,
                        gas_price: set_args.gas_price,
                        token_decimals: set_args.token_decimals,
                    };
                    let gas_oracle_config = GasOracleConfig {
                        domain: args.remote_domain,
                        gas_oracle: Some(GasOracle::RemoteGasData(remote_gas_data)),
                    };
                    let instruction =
                        hyperlane_sealevel_igp::instruction::set_gas_oracle_configs_instruction(
                            core_program_ids.igp_program_id,
                            core_program_ids.igp_account,
                            ctx.payer_pubkey,
                            vec![gas_oracle_config],
                        )
                        .unwrap();
                    ctx.new_txn().add(instruction).send_with_payer();
                    println!("Set gas oracle for remote domain {:?}", args.remote_domain);
                }
                GetSetCmd::Get(_) => {
                    let igp_account = ctx
                        .client
                        .get_account_with_commitment(&core_program_ids.igp_account, ctx.commitment)
                        .unwrap()
                        .value
                        .expect(
                            "IGP account not found. Make sure you are connected to the right RPC.",
                        );

                    let igp_account = IgpAccount::fetch(&mut &igp_account.data[..])
                        .unwrap()
                        .into_inner();

                    println!(
                        "IGP account gas oracle: {:#?}",
                        igp_account.gas_oracles.get(&args.remote_domain)
                    );
                }
            }
        }
        IgpSubCmd::DestinationGasOverhead(args) => {
            let core_program_ids = read_core_program_ids(
                &args.env_args.environments_dir,
                &args.env_args.environment,
                &args.chain_name,
            );
            match args.cmd {
                GasOverheadSubCmd::Get => {
                    // Read the gas overhead config
                    let overhead_igp_account = ctx
                        .client
                        .get_account_with_commitment(
                            &core_program_ids.overhead_igp_account,
                            ctx.commitment,
                        )
                        .unwrap()
                        .value
                        .expect("Overhead IGP account not found. Make sure you are connected to the right RPC.");
                    let overhead_igp_account =
                        OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
                            .unwrap()
                            .into_inner();
                    println!(
                        "Overhead IGP account gas oracle: {:#?}",
                        overhead_igp_account.gas_overheads.get(&args.remote_domain)
                    );
                }
                GasOverheadSubCmd::Set(set_args) => {
                    let overhead_config = GasOverheadConfig {
                        destination_domain: args.remote_domain,
                        gas_overhead: Some(set_args.gas_overhead),
                    };
                    // Set the gas overhead config
                    let instruction =
                        hyperlane_sealevel_igp::instruction::set_destination_gas_overheads(
                            core_program_ids.igp_program_id,
                            core_program_ids.overhead_igp_account,
                            ctx.payer_pubkey,
                            vec![overhead_config],
                        )
                        .unwrap();
                    ctx.new_txn().add(instruction).send_with_payer();
                    println!(
                        "Set gas overheads for remote domain {:?}",
                        args.remote_domain
                    )
                }
            }
        }
        IgpSubCmd::TransferIgpOwnership(ref transfer_ownership)
        | IgpSubCmd::TransferOverheadIgpOwnership(ref transfer_ownership) => {
            let igp_account_type = match cmd.cmd {
                IgpSubCmd::TransferIgpOwnership(_) => {
                    InterchainGasPaymasterType::Igp(transfer_ownership.igp_account)
                }
                IgpSubCmd::TransferOverheadIgpOwnership(_) => {
                    InterchainGasPaymasterType::OverheadIgp(transfer_ownership.igp_account)
                }
                _ => unreachable!(),
            };
            let instruction =
                hyperlane_sealevel_igp::instruction::transfer_igp_account_ownership_instruction(
                    transfer_ownership.program_id,
                    igp_account_type.clone(),
                    ctx.payer_pubkey,
                    Some(transfer_ownership.new_owner),
                )
                .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!(
                        "Transfer ownership of {:?} to {}",
                        igp_account_type, transfer_ownership.new_owner
                    ),
                )
                .send_with_payer();
        }
        IgpSubCmd::Configure(args) => {
            configure_igp_and_overhead_igp(
                &mut ctx,
                args.program_id,
                args.chain,
                &args.gas_oracle_config_file,
                &args.chain_config_file,
                args.account_salt,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn deploy_igp_program(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_igp",
        built_so_dir
            .join("hyperlane_sealevel_igp.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed IGP at program ID {}", program_id);

    let (program_data_account, _program_data_bump) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::igp_program_data_pda_seeds!(),
        &program_id,
    );

    // Initialize the program data
    let instruction =
        hyperlane_sealevel_igp::instruction::init_instruction(program_id, ctx.payer_pubkey)
            .unwrap();

    ctx.new_txn()
        .add_with_description(
            instruction,
            format!("Initializing IGP program data {}", program_data_account),
        )
        .send_with_payer();

    program_id
}

fn init_igp_account(ctx: &mut Context, program_id: Pubkey, salt: H256) -> Pubkey {
    // Initialize IGP with the given salt
    let (igp_account_pda, _igp_account_bump) =
        Pubkey::find_program_address(hyperlane_sealevel_igp::igp_pda_seeds!(salt), &program_id);

    if ctx
        .client
        .get_account_with_commitment(&igp_account_pda, ctx.commitment)
        .unwrap()
        .value
        .is_none()
    {
        let instruction = hyperlane_sealevel_igp::instruction::init_igp_instruction(
            program_id,
            ctx.payer_pubkey,
            salt,
            Some(ctx.payer_pubkey),
            ctx.payer_pubkey,
        )
        .unwrap();

        ctx.new_txn()
            .add_with_description(
                instruction,
                format!("Initializing IGP account {}", igp_account_pda),
            )
            .send_with_payer();
    } else {
        println!(
            "IGP account {} already exists, not creating",
            igp_account_pda
        );
    }

    igp_account_pda
}

fn init_overhead_igp_account(
    ctx: &mut Context,
    program_id: Pubkey,
    inner_igp_account: Pubkey,
    salt: H256,
) -> Pubkey {
    let (overhead_igp_account, _) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
        &program_id,
    );

    if ctx
        .client
        .get_account_with_commitment(&overhead_igp_account, ctx.commitment)
        .unwrap()
        .value
        .is_none()
    {
        let instruction = hyperlane_sealevel_igp::instruction::init_overhead_igp_instruction(
            program_id,
            ctx.payer_pubkey,
            salt,
            Some(ctx.payer_pubkey),
            inner_igp_account,
        )
        .unwrap();

        ctx.new_txn()
            .add_with_description(
                instruction,
                format!("Initializing overhead IGP account {}", overhead_igp_account),
            )
            .send_with_payer();
    } else {
        println!(
            "Overhead IGP account {} already exists, not creating",
            overhead_igp_account
        );
    }

    overhead_igp_account
}

/// Idempotently applies gas oracles to the IGP account and overheads to the Overhead IGP
/// account relating to the IGP account salt.
fn configure_igp_and_overhead_igp(
    ctx: &mut Context,
    program_id: Pubkey,
    local_chain: String,
    gas_oracle_config_file: &Path,
    chain_config_path: &Path,
    account_salt: Option<H256>,
) {
    let chain_configs = read_json::<HashMap<String, ChainMetadata>>(chain_config_path);

    let gas_oracle_configs = read_json::<
        HashMap<String, HashMap<String, GasOracleConfigWithOverhead>>,
    >(gas_oracle_config_file);
    let gas_oracle_config = gas_oracle_configs.get(&local_chain).unwrap();

    let salt = account_salt.unwrap_or_else(H256::zero);

    let (igp_account_pubkey, _bump) =
        Pubkey::find_program_address(hyperlane_sealevel_igp::igp_pda_seeds!(salt), &program_id);
    let igp_account = ctx
        .client
        .get_account_with_commitment(&igp_account_pubkey, ctx.commitment)
        .unwrap()
        .value
        .expect("IGP account not found. Make sure you are connected to the right RPC.");
    let igp_account = IgpAccount::fetch(&mut &igp_account.data[..])
        .unwrap()
        .into_inner();

    let (overhead_igp_account_pubkey, _bump) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
        &program_id,
    );
    let overhead_igp_account = ctx
        .client
        .get_account_with_commitment(&overhead_igp_account_pubkey, ctx.commitment)
        .unwrap()
        .value
        .expect("Overhead IGP account not found. Make sure you are connected to the right RPC.");
    let overhead_igp_account = OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
        .unwrap()
        .into_inner();

    // Set IGP configurations
    println!(
        "Setting IGP configurations for IGP account {} and overhead IGP account {}",
        igp_account_pubkey, overhead_igp_account_pubkey
    );

    let all_config_domain_ids = gas_oracle_config
        .iter()
        .map(|(remote, _)| chain_configs.get(remote).unwrap().domain_id())
        .collect::<HashSet<_>>();

    // Remove any gas oracles not in the config
    for (remote_domain, _) in igp_account.gas_oracles.iter() {
        if !all_config_domain_ids.contains(remote_domain) {
            let gas_oracle_config = GasOracleConfig {
                domain: *remote_domain,
                gas_oracle: None,
            };
            println!(
                "Removing oracle for remote domain {:?} that is not in the config",
                remote_domain
            );
            // For simplicity and to always be well within max tx sizes, just send one config at a time
            let instruction =
                hyperlane_sealevel_igp::instruction::set_gas_oracle_configs_instruction(
                    program_id,
                    igp_account_pubkey,
                    ctx.payer_pubkey,
                    vec![gas_oracle_config],
                )
                .unwrap();

            ctx.new_txn().add(instruction).send_with_payer();

            println!("Removed gas oracle for remote domain {:?}", remote_domain);
        }
    }

    // Remove any gas overheads not in the config
    for (remote_domain, _) in overhead_igp_account.gas_overheads.iter() {
        if !all_config_domain_ids.contains(remote_domain) {
            let overhead_config = GasOverheadConfig {
                destination_domain: *remote_domain,
                gas_overhead: None,
            };
            println!(
                "Removing overhead for remote domain {:?} that is not in the config",
                remote_domain
            );
            // For simplicity and to always be well within max tx sizes, just send one config at a time
            let instruction = hyperlane_sealevel_igp::instruction::set_destination_gas_overheads(
                program_id,
                overhead_igp_account_pubkey,
                ctx.payer_pubkey,
                vec![overhead_config],
            )
            .unwrap();

            ctx.new_txn().add(instruction).send_with_payer();

            println!("Removed gas overhead for remote domain {:?}", remote_domain);
        }
    }

    // Make sure the gas oracles and overheads are set correctly
    for (remote, config) in gas_oracle_config.iter() {
        let remote_domain = chain_configs.get(remote).unwrap().domain_id();
        let gas_oracle_config = GasOracleConfig {
            domain: remote_domain,
            gas_oracle: Some(GasOracle::RemoteGasData(config.oracle_config.clone())),
        };

        // Gas oracle on the IGP account
        if !map_configuration_matches(
            &igp_account.gas_oracles,
            remote,
            remote_domain,
            gas_oracle_config.gas_oracle.as_ref(),
        ) {
            println!(
                "Setting gas oracle for remote domain {:?} ({:?}) with config {:?}",
                remote, remote_domain, gas_oracle_config
            );
            // For simplicity and to always be well within max tx sizes, just send one config at a time
            let instruction =
                hyperlane_sealevel_igp::instruction::set_gas_oracle_configs_instruction(
                    program_id,
                    igp_account_pubkey,
                    ctx.payer_pubkey,
                    vec![gas_oracle_config],
                )
                .unwrap();

            ctx.new_txn().add(instruction).send_with_payer();

            println!(
                "Set gas oracle for remote domain {:?} ({:?})",
                remote, remote_domain
            );
        }

        // Overhead on the Overhead IGP account
        if !map_configuration_matches(
            &overhead_igp_account.gas_overheads,
            remote,
            remote_domain,
            config.overhead.as_ref(),
        ) {
            let overhead_config = GasOverheadConfig {
                destination_domain: remote_domain,
                gas_overhead: config.overhead,
            };
            println!(
                "Setting gas overhead for remote domain {:?} ({:?}) with config {:?}",
                remote, remote_domain, overhead_config
            );
            // For simplicity and to always be well within max tx sizes, just send one config at a time
            let instruction = hyperlane_sealevel_igp::instruction::set_destination_gas_overheads(
                program_id,
                overhead_igp_account_pubkey,
                ctx.payer_pubkey,
                vec![overhead_config],
            )
            .unwrap();

            ctx.new_txn().add(instruction).send_with_payer();

            println!(
                "Set gas overhead for remote domain {:?} ({:?})",
                remote, remote_domain
            );
        }
    }
}

fn map_configuration_matches<T>(
    existing_map: &HashMap<u32, T>,
    remote: &String,
    remote_domain: u32,
    new_config: Option<&T>,
) -> bool
where
    T: PartialEq + std::fmt::Debug,
{
    let existing_config = existing_map.get(&remote_domain);
    if existing_config == new_config {
        println!(
            "Configuration for remote domain {:?} ({:?}) matches expected config: {:?}",
            remote, remote_domain, new_config
        );
        true
    } else {
        println!(
            "Configuration for remote domain {:?} ({:?}) does not match expected config. Current value: {:?}, expected value: {:?}",
            remote, remote_domain, existing_config, new_config
        );
        false
    }
}
