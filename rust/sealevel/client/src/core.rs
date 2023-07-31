use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::{signature::Signer, signer::keypair::Keypair};

use std::{fs::File, io::Write, path::Path, str::FromStr};

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, deploy_program},
    Context, CoreCmd, CoreSubCmd,
};
use hyperlane_core::H256;

pub(crate) fn process_core_cmd(mut ctx: Context, cmd: CoreCmd) {
    match cmd.cmd {
        CoreSubCmd::Deploy(core) => {
            let environments_dir = create_new_directory(&core.environments_dir, &core.environment);
            let chain_dir = create_new_directory(&environments_dir, &core.chain);
            let core_dir = create_new_directory(&chain_dir, "core");
            let key_dir = create_new_directory(&core_dir, "keys");

            let ism_program_id = deploy_multisig_ism_message_id(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
            );

            let mailbox_program_id = deploy_mailbox(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                core.local_domain,
                ism_program_id,
            );

            let validator_announce_program_id = deploy_validator_announce(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                mailbox_program_id,
                core.local_domain,
            );

            let (igp_program_id, overhead_igp_account, igp_account) = deploy_igp(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                core.gas_oracle_config_file.as_deref(),
            );

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

fn deploy_multisig_ism_message_id(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &Path,
    built_so_dir: &Path,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_multisig_ism_message_id-keypair.json",
        use_existing_key,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        built_so_dir
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

    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    println!("Initialized Multisig ISM Message ID ");

    program_id
}

fn deploy_mailbox(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &Path,
    built_so_dir: &Path,
    local_domain: u32,
    default_ism: Pubkey,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_mailbox-keypair.json",
        use_existing_key,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        built_so_dir
            .join("hyperlane_sealevel_mailbox.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
    );

    println!("Deployed Mailbox at program ID {}", program_id);

    // Initialize
    let instruction = hyperlane_sealevel_mailbox::instruction::init_instruction(
        program_id,
        local_domain,
        default_ism,
        ctx.payer.pubkey(),
    )
    .unwrap();

    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    println!("Initialized Mailbox");

    program_id
}

fn deploy_validator_announce(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &Path,
    built_so_dir: &Path,
    mailbox_program_id: Pubkey,
    local_domain: u32,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_validator_announce-keypair.json",
        use_existing_key,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        built_so_dir
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
        local_domain,
    )
    .unwrap();

    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    println!("Initialized ValidatorAnnounce");

    program_id
}

fn deploy_igp(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &Path,
    built_so_dir: &Path,
    gas_oracle_config_file: Option<&Path>,
) -> (Pubkey, Pubkey, Pubkey) {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_igp-keypair.json",
        use_existing_key,
    );
    let program_id = keypair.pubkey();
    let gas_oracle_configs: Option<Vec<hyperlane_sealevel_igp::instruction::GasOracleConfig>> =
        gas_oracle_config_file.map(|p| {
            let file = File::open(p).expect("Failed to open oracle config file");
            serde_json::from_reader(file).expect("Failed to parse oracle config file")
        });

    deploy_program(
        &ctx.payer_path,
        keypair_path.to_str().unwrap(),
        built_so_dir
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

    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

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
    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

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
    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    let (overhead_igp_account, _) = Pubkey::find_program_address(
        hyperlane_sealevel_igp::overhead_igp_pda_seeds!(salt),
        &program_id,
    );

    println!("Initialized overhead IGP account {}", overhead_igp_account);

    if let Some(gas_oracle_configs) = gas_oracle_configs {
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

        ctx.instructions.push(instruction);
        ctx.send_transaction(&[&ctx.payer]);
        ctx.instructions.clear();

        println!("Set gas oracle for remote domains {domains:?}",);
    } else {
        println!("Skipping settings gas oracle config");
    }

    // Now make a gas payment for a message ID
    let message_id =
        H256::from_str("0x6969000000000000000000000000000000000000000000000000000000006969")
            .unwrap();
    let unique_gas_payment_keypair = Keypair::new();
    let (instruction, gas_payment_data_account) =
        hyperlane_sealevel_igp::instruction::pay_for_gas_instruction(
            program_id,
            ctx.payer.pubkey(),
            igp_account,
            unique_gas_payment_keypair.pubkey(),
            message_id,
            13376,
            100000,
        )
        .unwrap();
    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer, &unique_gas_payment_keypair]);
    ctx.instructions.clear();

    println!(
        "Made a payment for message {} with gas payment data account {}",
        message_id, gas_payment_data_account
    );

    (program_id, overhead_igp_account, igp_account)
}

#[derive(Debug)]
pub(crate) struct CoreProgramIds {
    pub mailbox: Pubkey,
    pub validator_announce: Pubkey,
    pub multisig_ism_message_id: Pubkey,
    pub igp_program_id: Pubkey,
    pub overhead_igp_account: Pubkey,
    pub igp_account: Pubkey,
}

impl From<PrettyCoreProgramIds> for CoreProgramIds {
    fn from(program_ids: PrettyCoreProgramIds) -> Self {
        Self {
            mailbox: Pubkey::from_str(program_ids.mailbox.as_str()).unwrap(),
            validator_announce: Pubkey::from_str(program_ids.validator_announce.as_str()).unwrap(),
            multisig_ism_message_id: Pubkey::from_str(program_ids.multisig_ism_message_id.as_str())
                .unwrap(),
            igp_program_id: Pubkey::from_str(program_ids.igp_program_id.as_str()).unwrap(),
            overhead_igp_account: Pubkey::from_str(program_ids.overhead_igp_account.as_str())
                .unwrap(),
            igp_account: Pubkey::from_str(program_ids.igp_account.as_str()).unwrap(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PrettyCoreProgramIds {
    mailbox: String,
    validator_announce: String,
    multisig_ism_message_id: String,
    igp_program_id: String,
    overhead_igp_account: String,
    igp_account: String,
}

impl From<CoreProgramIds> for PrettyCoreProgramIds {
    fn from(program_ids: CoreProgramIds) -> Self {
        Self {
            mailbox: program_ids.mailbox.to_string(),
            validator_announce: program_ids.validator_announce.to_string(),
            multisig_ism_message_id: program_ids.multisig_ism_message_id.to_string(),
            igp_program_id: program_ids.igp_program_id.to_string(),
            overhead_igp_account: program_ids.overhead_igp_account.to_string(),
            igp_account: program_ids.igp_account.to_string(),
        }
    }
}

fn write_program_ids(core_dir: &Path, program_ids: CoreProgramIds) {
    let pretty_program_ids = PrettyCoreProgramIds::from(program_ids);

    let json = serde_json::to_string_pretty(&pretty_program_ids).unwrap();
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

    let pretty_program_ids: PrettyCoreProgramIds =
        serde_json::from_reader(file).expect("Failed to read program IDs file");

    CoreProgramIds::from(pretty_program_ids)
}
