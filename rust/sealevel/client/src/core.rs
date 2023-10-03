use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::signature::Signer;

use std::collections::HashMap;
use std::{fs::File, path::Path};

use crate::{
    artifacts::{read_json, write_json},
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program},
    multisig_ism::deploy_multisig_ism_message_id,
    Context, CoreCmd, CoreDeploy, CoreSubCmd,
};
use hyperlane_core::H256;
use hyperlane_sealevel_igp::accounts::{SOL_DECIMALS, TOKEN_EXCHANGE_RATE_SCALE};

pub(crate) fn process_core_cmd(mut ctx: Context, cmd: CoreCmd) {
    match cmd.cmd {
        CoreSubCmd::Deploy(core) => {
            let environments_dir = create_new_directory(&core.environments_dir, &core.environment);
            let chain_dir = create_new_directory(&environments_dir, &core.chain);
            let core_dir = create_new_directory(&chain_dir, "core");
            let key_dir = create_new_directory(&core_dir, "keys");

            let ism_program_id = deploy_multisig_ism_message_id(
                &mut ctx,
                &core.built_so_dir,
                core.use_existing_keys,
                &key_dir,
            );

            let mailbox_program_id = deploy_mailbox(&mut ctx, &core, &key_dir, ism_program_id);

            let validator_announce_program_id =
                deploy_validator_announce(&mut ctx, &core, &key_dir, mailbox_program_id);

            let (igp_program_id, overhead_igp_account, igp_account) =
                deploy_igp(&mut ctx, &core, &key_dir);

            let program_ids = CoreProgramIds {
                mailbox: mailbox_program_id,
                validator_announce: validator_announce_program_id,
                multisig_ism_message_id: ism_program_id,
                igp_program_id,
                overhead_igp_account,
                igp_account,
            };
            write_program_ids(&core_dir, program_ids);
        }
    }
}

fn deploy_mailbox(
    ctx: &mut Context,
    core: &CoreDeploy,
    key_dir: &Path,
    default_ism: Pubkey,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_mailbox-keypair.json",
        core.use_existing_keys,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        ctx.payer_keypair_path(),
        keypair_path.to_str().unwrap(),
        core.built_so_dir
            .join("hyperlane_sealevel_mailbox.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

    println!("Deployed Mailbox at program ID {}", program_id);

    // Initialize
    let instruction = hyperlane_sealevel_mailbox::instruction::init_instruction(
        program_id,
        core.local_domain,
        default_ism,
        ctx.payer_pubkey,
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    println!("Initialized Mailbox");

    program_id
}

fn deploy_validator_announce(
    ctx: &mut Context,
    core: &CoreDeploy,
    key_dir: &Path,
    mailbox_program_id: Pubkey,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_validator_announce-keypair.json",
        core.use_existing_keys,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        ctx.payer_keypair_path(),
        keypair_path.to_str().unwrap(),
        core.built_so_dir
            .join("hyperlane_sealevel_validator_announce.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

    println!("Deployed ValidatorAnnounce at program ID {}", program_id);

    // Initialize
    let instruction = hyperlane_sealevel_validator_announce::instruction::init_instruction(
        program_id,
        ctx.payer_pubkey,
        mailbox_program_id,
        core.local_domain,
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    println!("Initialized ValidatorAnnounce");

    program_id
}

#[allow(clippy::too_many_arguments)]
fn deploy_igp(ctx: &mut Context, core: &CoreDeploy, key_dir: &Path) -> (Pubkey, Pubkey, Pubkey) {
    use hyperlane_sealevel_igp::{
        accounts::{GasOracle, RemoteGasData},
        instruction::{GasOracleConfig, GasOverheadConfig},
    };

    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_igp-keypair.json",
        core.use_existing_keys,
    );
    let program_id = keypair.pubkey();

    let mut gas_oracle_configs = core
        .gas_oracle_config_file
        .as_deref()
        .map(|p| {
            let file = File::open(p).expect("Failed to open oracle config file");
            serde_json::from_reader::<_, Vec<GasOracleConfig>>(file)
                .expect("Failed to parse oracle config file")
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.domain != core.local_domain)
        .map(|c| (c.domain, c))
        .collect::<HashMap<_, _>>();
    for &remote in &core.remote_domains {
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

    let overhead_configs = core
        .overhead_config_file
        .as_deref()
        .map(|p| {
            let file = File::open(p).expect("Failed to open overhead config file");
            serde_json::from_reader::<_, Vec<GasOverheadConfig>>(file)
                .expect("Failed to parse overhead config file")
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.destination_domain != core.local_domain)
        .map(|c| (c.destination_domain, c))
        .collect::<HashMap<_, _>>() // dedup
        .into_values()
        .collect::<Vec<_>>();

    deploy_program(
        ctx.payer_keypair_path(),
        keypair_path.to_str().unwrap(),
        core.built_so_dir
            .join("hyperlane_sealevel_igp.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

    println!("Deployed IGP at program ID {}", program_id);

    // Initialize the program data
    let instruction =
        hyperlane_sealevel_igp::instruction::init_instruction(program_id, ctx.payer_pubkey)
            .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    let (program_data_account, _program_data_bump) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::igp_program_data_pda_seeds!(),
        &program_id,
    );
    println!("Initialized IGP program data {}", program_data_account);

    // Initialize IGP with salt zero
    let salt = H256::zero();
    let instruction = hyperlane_sealevel_igp::instruction::init_igp_instruction(
        program_id,
        ctx.payer_pubkey,
        salt,
        Some(ctx.payer_pubkey),
        ctx.payer_pubkey,
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    let (igp_account, _igp_account_bump) =
        Pubkey::find_program_address(hyperlane_sealevel_igp::igp_pda_seeds!(salt), &program_id);
    println!("Initialized IGP account {}", igp_account);

    let instruction = hyperlane_sealevel_igp::instruction::init_overhead_igp_instruction(
        program_id,
        ctx.payer_pubkey,
        salt,
        Some(ctx.payer_pubkey),
        igp_account,
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    let (overhead_igp_account, _) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
        &program_id,
    );

    println!("Initialized overhead IGP account {}", overhead_igp_account);

    if !gas_oracle_configs.is_empty() {
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

    if !overhead_configs.is_empty() {
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

    (program_id, overhead_igp_account, igp_account)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CoreProgramIds {
    #[serde(with = "crate::serde::serde_pubkey")]
    pub mailbox: Pubkey,
    #[serde(with = "crate::serde::serde_pubkey")]
    pub validator_announce: Pubkey,
    #[serde(with = "crate::serde::serde_pubkey")]
    pub multisig_ism_message_id: Pubkey,
    #[serde(with = "crate::serde::serde_pubkey")]
    pub igp_program_id: Pubkey,
    #[serde(with = "crate::serde::serde_pubkey")]
    pub overhead_igp_account: Pubkey,
    #[serde(with = "crate::serde::serde_pubkey")]
    pub igp_account: Pubkey,
}

fn write_program_ids(core_dir: &Path, program_ids: CoreProgramIds) {
    write_json(&core_dir.join("program-ids.json"), program_ids);
}

pub(crate) fn read_core_program_ids(
    environments_dir: &Path,
    environment: &str,
    chain: &str,
) -> CoreProgramIds {
    let path = environments_dir
        .join(environment)
        .join(chain)
        .join("core")
        .join("program-ids.json");
    read_json(&path)
}
