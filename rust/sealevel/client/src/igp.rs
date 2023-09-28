use std::collections::HashMap;

use crate::{
    cmd_utils::{create_and_write_keypair, deploy_program},
    read_core_program_ids, Context, GasOverheadSubCmd, GetSetCmd, IgpCmd, IgpSubCmd,
};
use hyperlane_sealevel_igp::accounts::{SOL_DECIMALS, TOKEN_EXCHANGE_RATE_SCALE};

use std::{
    fs::File,
    path::{Path, PathBuf},
    str::FromStr,
};

use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer as _},
};

use hyperlane_core::H256;

use hyperlane_sealevel_igp::{
    accounts::{
        GasOracle, GasPaymentAccount, IgpAccount, InterchainGasPaymasterType, OverheadIgpAccount,
        ProgramDataAccount as IgpProgramDataAccount, RemoteGasData,
    },
    igp_program_data_pda_seeds,
    instruction::{GasOracleConfig, GasOverheadConfig},
};

struct IgpArtifacts {
    program_id: Pubkey,
    default_igp_account: Pubkey,
    default_overhead_igp_account: Pubkey,
}

pub(crate) fn process_igp_cmd(ctx: Context, cmd: IgpCmd) {
    match cmd.cmd {
        IgpSubCmd::DeployProgram(deploy) => {
            let environments_dir =
                create_new_directory(&deploy.environments_dir, &deploy.environment);
            let ism_dir = create_new_directory(&environments_dir, "igp");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let key_dir = create_new_directory(&chain_dir, "keys");

            let ism_program_id = deploy_igp_program(&mut ctx, &deploy.built_so_dir, true, &key_dir);

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                ism_program_id.into(),
            );
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
            let salt = H256::zero();
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

            ctx.new_txn()
                .add(ixn)
                .send(&[&*ctx.payer_signer(), &unique_gas_payment_keypair]);

            println!(
                "Made a payment for message {} with gas payment data account {}",
                payment_details.message_id, gas_payment_data_account
            );
        }
        IgpSubCmd::GasOracleConfig(args) => {
            let core_program_ids =
                read_core_program_ids(&args.environments_dir, &args.environment, &args.chain_name);
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
            let core_program_ids =
                read_core_program_ids(&args.environments_dir, &args.environment, &args.chain_name);
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
    }
}

#[allow(clippy::too_many_arguments)]
fn deploy_igp_program(
    ctx: &mut Context,
    built_so_dir: &Path,
    use_existing_keys: bool,
    key_dir: &Path,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_igp-keypair.json",
        use_existing_keys,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        ctx.payer_keypair_path(),
        keypair_path.to_str().unwrap(),
        built_so_dir
            .join("hyperlane_sealevel_igp.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

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

fn init_and_configure_igp_account(
    ctx: &mut Context,
    program_id: Pubkey,
    local_domain: u32,
    remote_domains: Vec<u32>,
    salt: H256,
    gas_oracle_config_file: Option<PathBuf>,
) -> Pubkey {
    let mut gas_oracle_configs = gas_oracle_config_file
        .as_deref()
        .map(|p| {
            let file = File::open(p).expect("Failed to open oracle config file");
            serde_json::from_reader::<_, Vec<GasOracleConfig>>(file)
                .expect("Failed to parse oracle config file")
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.domain != local_domain)
        .map(|c| (c.domain, c))
        .collect::<HashMap<_, _>>();

    // Default
    for &remote in &remote_domains {
        gas_oracle_configs
            .entry(remote)
            .or_insert_with(|| GasOracleConfig {
                domain: remote,
                gas_oracle: Some(GasOracle::RemoteGasData(RemoteGasData {
                    token_exchange_rate: TOKEN_EXCHANGE_RATE_SCALE,
                    gas_price: 1,
                    token_decimals: SOL_DECIMALS,
                })),
            });
    }
    let gas_oracle_configs = gas_oracle_configs.into_values().collect::<Vec<_>>();

    // Initialize IGP with the given salt
    let (igp_account, _igp_account_bump) =
        Pubkey::find_program_address(hyperlane_sealevel_igp::igp_pda_seeds!(salt), &program_id);

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
            format!("Initializing IGP account {}", igp_account),
        )
        .send_with_payer();

    if !gas_oracle_configs.is_empty() {
        // TODO: idempotency

        let domains = gas_oracle_configs
            .iter()
            .map(|c| c.domain)
            .collect::<Vec<_>>();
        let instruction = hyperlane_sealevel_igp::instruction::set_gas_oracle_configs_instruction(
            program_id,
            igp_account,
            ctx.payer_pubkey,
            gas_oracle_configs,
        )
        .unwrap();

        ctx.new_txn().add(instruction).send_with_payer();

        println!("Set gas oracle for remote domains {domains:?}",);
    } else {
        println!("Skipping settings gas oracle config");
    }

    igp_account
}

fn init_overhead_igp_account(
    ctx: &mut Context,
    program_id: Pubkey,
    inner_igp_account: Pubkey,
    local_domain: u32,
    _remote_domains: Vec<u32>,
    salt: H256,
    overhead_config_file: Option<PathBuf>,
) -> Pubkey {
    let overhead_configs = overhead_config_file
        .as_deref()
        .map(|p| {
            let file = File::open(p).expect("Failed to open overhead config file");
            serde_json::from_reader::<_, Vec<GasOverheadConfig>>(file)
                .expect("Failed to parse overhead config file")
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.destination_domain != local_domain)
        .map(|c| (c.destination_domain, c))
        .collect::<HashMap<_, _>>() // dedup
        .into_values()
        .collect::<Vec<_>>();

    let (overhead_igp_account, _) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
        &program_id,
    );

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

    if !overhead_configs.is_empty() {
        // TODO: idempotency

        let domains = overhead_configs
            .iter()
            .map(|c| c.destination_domain)
            .collect::<Vec<_>>();

        let instruction = hyperlane_sealevel_igp::instruction::set_destination_gas_overheads(
            program_id,
            overhead_igp_account,
            ctx.payer_pubkey,
            overhead_configs,
        )
        .unwrap();

        ctx.new_txn().add(instruction).send_with_payer();

        println!("Set gas overheads for remote domains {domains:?}",)
    } else {
        println!("Skipping setting gas overheads");
    }

    overhead_igp_account
}
