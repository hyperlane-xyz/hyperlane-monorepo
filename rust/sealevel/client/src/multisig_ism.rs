use std::collections::{HashMap, HashSet};
use std::{fs::File, path::Path};

use serde::{Deserialize, Serialize};
use solana_program::pubkey::Pubkey;
use solana_sdk::instruction::Instruction;

use crate::registry::FileSystemRegistry;
use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    Context, MultisigIsmMessageIdCmd, MultisigIsmMessageIdSubCmd,
};

use hyperlane_core::H160;

use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds,
    accounts::{AccessControlAccount, DomainDataAccount},
    domain_data_pda_seeds,
    instruction::{set_validators_and_threshold_instruction, ValidatorsAndThreshold},
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MultisigIsmConfig {
    /// Note this type is ignored in this tooling. It'll always assume this
    /// relates to a multisig-ism-message-id variant, which is the only type
    /// implemented in Sealevel.
    /// Commenting out for now until this is needed, and due to `infra`
    /// generating non-numeric types at the moment.
    // #[serde(rename = "type")]
    // pub module_type: u8,
    pub validators: Vec<H160>,
    pub threshold: u8,
}

impl From<MultisigIsmConfig> for ValidatorsAndThreshold {
    fn from(val: MultisigIsmConfig) -> Self {
        ValidatorsAndThreshold {
            validators: val.validators,
            threshold: val.threshold,
        }
    }
}

pub(crate) fn process_multisig_ism_message_id_cmd(mut ctx: Context, cmd: MultisigIsmMessageIdCmd) {
    match cmd.cmd {
        MultisigIsmMessageIdSubCmd::Deploy(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "multisig-ism-message-id");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let context_dir = create_new_directory(&chain_dir, &deploy.context);
            let key_dir = create_new_directory(&context_dir, "keys");

            let registry = FileSystemRegistry::new(deploy.registry.to_path_buf());
            let chain_metadatas = registry.get_metadata();
            let chain_metadata = chain_metadatas.get(&deploy.chain).unwrap();
            let local_domain = chain_metadata.domain_id;
            println!("Local domain: {}", local_domain);

            let ism_program_id = deploy_multisig_ism_message_id(
                &mut ctx,
                &deploy.built_so_dir,
                &key_dir,
                local_domain,
            );

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                ism_program_id.into(),
            );
        }
        MultisigIsmMessageIdSubCmd::Init(init) => {
            let init_instruction =
                hyperlane_sealevel_multisig_ism_message_id::instruction::init_instruction(
                    init.program_id,
                    ctx.payer_pubkey,
                )
                .unwrap();
            ctx.new_txn().add(init_instruction).send_with_payer();
        }
        MultisigIsmMessageIdSubCmd::SetValidatorsAndThreshold(set_config) => {
            set_validators_and_threshold(
                &mut ctx,
                set_config.program_id,
                set_config.domain,
                ValidatorsAndThreshold {
                    validators: set_config.validators,
                    threshold: set_config.threshold,
                },
            );
        }
        MultisigIsmMessageIdSubCmd::Query(query) => {
            let (access_control_pda_key, _access_control_pda_bump) =
                Pubkey::find_program_address(access_control_pda_seeds!(), &query.program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[access_control_pda_key], ctx.commitment)
                .unwrap()
                .value;
            let access_control =
                AccessControlAccount::fetch(&mut &accounts[0].as_ref().unwrap().data[..])
                    .unwrap()
                    .into_inner();
            println!("Access control: {:#?}", access_control);

            if let Some(domains) = query.domains {
                for domain in domains {
                    println!("Querying domain data for origin domain: {}", domain);

                    let (domain_data_pda_key, _domain_data_pda_bump) = Pubkey::find_program_address(
                        domain_data_pda_seeds!(domain),
                        &query.program_id,
                    );

                    let accounts = ctx
                        .client
                        .get_multiple_accounts_with_commitment(
                            &[domain_data_pda_key],
                            ctx.commitment,
                        )
                        .unwrap()
                        .value;

                    if let Some(account) = &accounts[0] {
                        let domain_data = DomainDataAccount::fetch(&mut &account.data[..])
                            .unwrap()
                            .into_inner();
                        println!("Domain data for {}:\n{:#?}", domain, domain_data);
                    } else {
                        println!("No domain data for domain {}", domain);
                    }
                }
            }
        }
        MultisigIsmMessageIdSubCmd::TransferOwnership(transfer_ownership) => {
            let instruction =
                hyperlane_sealevel_multisig_ism_message_id::instruction::transfer_ownership_instruction(
                    transfer_ownership.program_id,
                    ctx.payer_pubkey,
                    Some(transfer_ownership.new_owner),
                )
                .unwrap();

            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Transfer ownership to {}", transfer_ownership.new_owner),
                )
                .send_with_payer();
        }
        MultisigIsmMessageIdSubCmd::Configure(configure) => {
            configure_multisig_ism_message_id(
                &mut ctx,
                configure.program_id,
                &configure.multisig_config_file,
                &configure.registry,
            );
        }
    }
}

pub(crate) fn deploy_multisig_ism_message_id(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_multisig_ism_message_id",
        built_so_dir
            .join("hyperlane_sealevel_multisig_ism_message_id.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!(
        "Deployed Multisig ISM Message ID at program ID {}",
        program_id
    );

    // Initialize
    let instruction = hyperlane_sealevel_multisig_ism_message_id::instruction::init_instruction(
        program_id,
        ctx.payer_pubkey,
    )
    .unwrap();

    ctx.new_txn()
        .add_with_description(
            instruction,
            format!(
                "Initializing Multisig ISM Message ID with payer & owner {}",
                ctx.payer_pubkey
            ),
        )
        .send_with_payer();
    println!(
        "initialized Multisig ISM Message ID at program ID {}",
        program_id
    );

    program_id
}

/// Configures the multisig-ism-message-id program
/// with the validators and thresholds for each of the domains
/// specified in the multisig config file.
/// This implementation batches multiple set_validators_and_threshold instructions
/// into single transactions where possible to reduce the number of transactions.
fn configure_multisig_ism_message_id(
    ctx: &mut Context,
    program_id: Pubkey,
    multisig_config_file_path: &Path,
    registry_path: &Path,
) {
    let multisig_config_file =
        File::open(multisig_config_file_path).expect("Failed to open config file");
    let multisig_configs: HashMap<String, MultisigIsmConfig> =
        serde_json::from_reader(multisig_config_file).expect("Failed to read config file");

    let registry = FileSystemRegistry::new(registry_path.to_path_buf());
    let chain_metadatas = registry.get_metadata();

    // Collect all instructions that need to be executed
    // (chain_name of the set being update, instruction)
    let mut ism_update_instructions: Vec<(String, Instruction)> = Vec::new();

    // First gather all instructions that need to be executed
    for (chain_name, multisig_ism_config) in multisig_configs {
        println!(
            "Checking configuration for chain {} with config {:?}",
            chain_name, multisig_ism_config
        );
        let chain_metadata = chain_metadatas.get(&chain_name).unwrap();

        let matches = multisig_ism_config_matches_chain(
            ctx,
            program_id,
            chain_metadata.domain_id,
            &multisig_ism_config,
        );

        if matches {
            println!(
                "Multisig ISM Message ID already correctly configured for chain {}",
                chain_name
            );
        } else {
            println!(
                "Multisig ISM Message ID needs configuration update for chain {}",
                chain_name
            );

            let instruction = set_validators_and_threshold_instruction(
                program_id,
                ctx.payer_pubkey,
                chain_metadata.domain_id,
                multisig_ism_config.into(),
            )
            .unwrap();

            ism_update_instructions.push((chain_name, instruction));
        }
    }

    if ism_update_instructions.is_empty() {
        println!("No configuration updates needed");
        return;
    }

    // Should be sufficiently small to not hit the 1232 byte tx limit.
    // TODO: Make this dynamic based on the size of the instructions.
    const CHUNK_SIZE: usize = 5;

    // Process instructions in chunks
    for chunk in ism_update_instructions.chunks(CHUNK_SIZE) {
        let mut txn = ctx.new_txn();

        for (chain_name, instruction) in chunk {
            txn = txn.add_with_description(
                instruction.clone(),
                format!("Set validators and threshold for chain {}", chain_name),
            );
        }

        println!("Sending batch of {} instructions", chunk.len());
        txn.send_with_payer();
    }
}

fn multisig_ism_config_matches_chain(
    ctx: &mut Context,
    program_id: Pubkey,
    remote_domain: u32,
    expected: &MultisigIsmConfig,
) -> bool {
    let (domain_data_key, _domain_data_bump) =
        Pubkey::find_program_address(domain_data_pda_seeds!(remote_domain), &program_id);

    let domain_data_account = ctx
        .client
        .get_account_with_commitment(&domain_data_key, ctx.commitment)
        .expect("Failed to get domain data account")
        .value;

    if let Some(domain_data_account) = domain_data_account {
        let domain_data = DomainDataAccount::fetch(&mut &domain_data_account.data[..])
            .unwrap()
            .into_inner();
        let expected_validator_set =
            HashSet::<H160>::from_iter(expected.validators.iter().cloned());
        let actual_validator_set = HashSet::<H160>::from_iter(
            domain_data
                .validators_and_threshold
                .validators
                .iter()
                .cloned(),
        );

        expected_validator_set == actual_validator_set
            && expected.threshold == domain_data.validators_and_threshold.threshold
    } else {
        false
    }
}

pub(crate) fn set_validators_and_threshold(
    ctx: &mut Context,
    program_id: Pubkey,
    domain: u32,
    validators_and_threshold: ValidatorsAndThreshold,
) {
    let description = format!(
        "Set for remote domain {} validators and threshold: {:?}",
        domain, validators_and_threshold
    );
    ctx.new_txn()
        .add_with_description(
            set_validators_and_threshold_instruction(
                program_id,
                ctx.payer_pubkey,
                domain,
                validators_and_threshold,
            )
            .unwrap(),
            description,
        )
        .send_with_payer();
}
