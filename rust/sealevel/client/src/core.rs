use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::signature::Signer;

use std::{fs::File, io::Write, path::Path, str::FromStr};

use crate::{
    cmd_utils::{create_and_write_keypair, create_new_directory, create_new_file, deploy_program},
    Context, CoreCmd, CoreSubCmd,
};

pub(crate) fn process_core_cmd(mut ctx: Context, cmd: CoreCmd) {
    match cmd.cmd {
        CoreSubCmd::Deploy(core) => {
            let environments_dir = create_new_directory(&core.environments_dir, &core.environment);
            let chain_dir = create_new_directory(&environments_dir, &core.chain);
            let core_dir = create_new_directory(&chain_dir, "core");
            let key_dir = create_new_directory(&core_dir, "keys");
            let log_file = create_new_file(&core_dir, "deploy-logs.txt");

            let ism_program_id = deploy_multisig_ism_message_id(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                &log_file,
            );

            let mailbox_program_id = deploy_mailbox(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                &log_file,
                core.local_domain,
                ism_program_id,
            );

            let validator_announce_program_id = deploy_validator_announce(
                &mut ctx,
                core.use_existing_keys,
                &key_dir,
                &core.built_so_dir,
                &log_file,
                mailbox_program_id,
                core.local_domain,
            );

            let program_ids = CoreProgramIds {
                mailbox: mailbox_program_id,
                validator_announce: validator_announce_program_id,
                multisig_ism_message_id: ism_program_id,
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
    log_file: impl AsRef<Path>,
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
        log_file,
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

    println!("instruction {:?}", instruction);

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
    log_file: impl AsRef<Path>,
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
        log_file,
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
    log_file: impl AsRef<Path>,
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
        log_file,
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

#[derive(Debug)]
pub(crate) struct CoreProgramIds {
    pub mailbox: Pubkey,
    pub validator_announce: Pubkey,
    pub multisig_ism_message_id: Pubkey,
}

impl From<PrettyCoreProgramIds> for CoreProgramIds {
    fn from(program_ids: PrettyCoreProgramIds) -> Self {
        Self {
            mailbox: Pubkey::from_str(program_ids.mailbox.as_str()).unwrap(),
            validator_announce: Pubkey::from_str(program_ids.validator_announce.as_str()).unwrap(),
            multisig_ism_message_id: Pubkey::from_str(program_ids.multisig_ism_message_id.as_str())
                .unwrap(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PrettyCoreProgramIds {
    mailbox: String,
    validator_announce: String,
    multisig_ism_message_id: String,
}

impl From<CoreProgramIds> for PrettyCoreProgramIds {
    fn from(program_ids: CoreProgramIds) -> Self {
        Self {
            mailbox: program_ids.mailbox.to_string(),
            validator_announce: program_ids.validator_announce.to_string(),
            multisig_ism_message_id: program_ids.multisig_ism_message_id.to_string(),
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
