use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::{signature::Signer, signer::keypair::Keypair};

use std::collections::HashMap;
use std::{fs::File, io::Write, path::Path, str::FromStr};

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program},
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

            let ism_program_id = deploy_multisig_ism_message_id(&mut ctx, &core, &key_dir);

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

fn deploy_multisig_ism_message_id(ctx: &mut Context, cmd: &CoreDeploy, key_dir: &Path) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_multisig_ism_message_id-keypair.json",
        cmd.use_existing_keys,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        cmd.built_so_dir
            .join("hyperlane_sealevel_multisig_ism_message_id.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

    println!(
        "Deployed Multisig ISM Message ID at program ID {}",
        program_id
    );

    // Initialize
    let instruction = hyperlane_sealevel_multisig_ism_message_id::instruction::init_instruction(
        program_id,
        ctx.payer.pubkey(),
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    println!("Initialized Multisig ISM Message ID ");

    program_id
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
        &ctx.payer_path,
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
        ctx.payer.pubkey(),
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
        &ctx.payer_path,
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
        ctx.payer.pubkey(),
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
        &ctx.payer_path,
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
        hyperlane_sealevel_igp::instruction::init_instruction(program_id, ctx.payer.pubkey())
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
        ctx.payer.pubkey(),
        salt,
        Some(ctx.payer.pubkey()),
        ctx.payer.pubkey(),
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    let (igp_account, _igp_account_bump) =
        Pubkey::find_program_address(hyperlane_sealevel_igp::igp_pda_seeds!(salt), &program_id);
    println!("Initialized IGP account {}", igp_account);

    let instruction = hyperlane_sealevel_igp::instruction::init_overhead_igp_instruction(
        program_id,
        ctx.payer.pubkey(),
        salt,
        Some(ctx.payer.pubkey()),
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
            ctx.payer.pubkey(),
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
            ctx.payer.pubkey(),
            overhead_configs,
        )
        .unwrap();

        ctx.new_txn().add(instruction).send_with_payer();

        println!("Set gas overheads for remote domains {domains:?}",)
    } else {
        println!("Skipping setting gas overheads");
    }

    // TODO: this payment logic should be in the transfer remote and this block of code needs to be
    //  removed after that
    if core.remote_domains.contains(&13376) {
        // Now make a gas payment for a message ID
        let message_id =
            H256::from_str("0x7b8ba684e5ce44f898c5fa81785c83a00e32b5bef3412e648eb7a17bec497685")
                .unwrap();
        let unique_gas_payment_keypair = Keypair::new();
        let (instruction, gas_payment_data_account) =
            hyperlane_sealevel_igp::instruction::pay_for_gas_instruction(
                program_id,
                ctx.payer.pubkey(),
                igp_account,
                Some(overhead_igp_account),
                unique_gas_payment_keypair.pubkey(),
                message_id,
                13376,
                100000,
            )
            .unwrap();

        ctx.new_txn()
            .add(instruction)
            .send(&[&ctx.payer, &unique_gas_payment_keypair]);

        println!(
            "Made a payment for message {} with gas payment data account {}",
            message_id, gas_payment_data_account
        );
    }

    (program_id, overhead_igp_account, igp_account)
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CoreProgramIds {
    #[serde(with = "serde_pubkey")]
    pub mailbox: Pubkey,
    #[serde(with = "serde_pubkey")]
    pub validator_announce: Pubkey,
    #[serde(with = "serde_pubkey")]
    pub multisig_ism_message_id: Pubkey,
    #[serde(with = "serde_pubkey")]
    pub igp_program_id: Pubkey,
    #[serde(with = "serde_pubkey")]
    pub overhead_igp_account: Pubkey,
    #[serde(with = "serde_pubkey")]
    pub igp_account: Pubkey,
}

mod serde_pubkey {
    use borsh::BorshDeserialize;
    use serde::{Deserialize, Deserializer, Serializer};
    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum RawPubkey {
        String(String),
        Bytes(Vec<u8>),
    }

    pub fn serialize<S: Serializer>(k: &Pubkey, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&k.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Pubkey, D::Error> {
        match RawPubkey::deserialize(de)? {
            RawPubkey::String(s) => Pubkey::from_str(&s).map_err(serde::de::Error::custom),
            RawPubkey::Bytes(b) => Pubkey::try_from_slice(&b).map_err(serde::de::Error::custom),
        }
    }
}

fn write_program_ids(core_dir: &Path, program_ids: CoreProgramIds) {
    let json = serde_json::to_string_pretty(&program_ids).unwrap();
    let path = core_dir.join("program-ids.json");

    println!("Writing program IDs to {}:\n{}", path.display(), json);

    let mut file = File::create(path).expect("Failed to create keypair file");
    file.write_all(json.as_bytes())
        .expect("Failed to write program IDs to file");
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
    let file = File::open(path).expect("Failed to open program IDs file");
    serde_json::from_reader(file).expect("Failed to read program IDs file")
}
