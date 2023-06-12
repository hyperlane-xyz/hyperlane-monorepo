use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::{
    cmd_utils::{
        build_cmd, create_and_write_keypair, create_new_directory, create_new_file, deploy_program,
    },
    Context, DeployCmd, DeploySubCmd,
};

pub(crate) fn process_deploy_cmd(mut ctx: Context, cmd: DeployCmd) {
    match cmd.cmd {
        DeploySubCmd::Core(core) => {
            let environments_dir = create_new_directory(&core.environments_dir, &core.environment);
            let artifacts_dir = create_new_directory(&environments_dir, "core");
            let key_dir = create_new_directory(&artifacts_dir, "keys");
            let log_file = create_new_file(&artifacts_dir, "deploy-logs.txt");

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
                mailbox: mailbox_program_id.to_string(),
                validator_announce: validator_announce_program_id.to_string(),
                multisig_ism_message_id: ism_program_id.to_string(),
            };
            write_program_ids(&artifacts_dir, program_ids);
        }
    }
}

fn deploy_multisig_ism_message_id(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &PathBuf,
    built_so_dir: &PathBuf,
    log_file: impl AsRef<Path>,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_multisig_ism_message_id-keypair.json",
        use_existing_key,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        &ctx.payer,
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

    ctx.instructions.push(instruction);
    ctx.send_transaction(&[&ctx.payer]);
    ctx.instructions.clear();

    println!("Initialized Multisig ISM Message ID ");

    program_id
}

fn deploy_mailbox(
    ctx: &mut Context,
    use_existing_key: bool,
    key_dir: &PathBuf,
    built_so_dir: &PathBuf,
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
        &ctx.payer,
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
    key_dir: &PathBuf,
    built_so_dir: &PathBuf,
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
        &ctx.payer,
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

#[derive(Debug, Serialize)]
struct CoreProgramIds {
    mailbox: String,
    validator_announce: String,
    multisig_ism_message_id: String,
}

fn write_program_ids(artifacts_dir: &PathBuf, program_ids: CoreProgramIds) {
    let json = serde_json::to_string_pretty(&program_ids).unwrap();
    let path = artifacts_dir.join("program-ids.json");

    println!("Writing program IDs to {}:\n{}", path.display(), json);

    let mut file = File::create(path.clone()).expect("Failed to create keypair file");
    file.write_all(json.as_bytes())
        .expect("Failed to write program IDs to file");
}
