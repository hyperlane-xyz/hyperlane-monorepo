use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    signature::Signer,
    system_program,
};

use std::collections::{HashMap, HashSet};
use std::{fs::File, path::Path};

use crate::{
    cmd_utils::{create_and_write_keypair, deploy_program},
    router::ChainMetadata,
    Context,
};
use account_utils::DiscriminatorEncode;
use hyperlane_core::H160;

use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds,
    accounts::DomainDataAccount,
    domain_data_pda_seeds,
    instruction::{
        Domained, Instruction as MultisigIsmMessageIdInstruction, ValidatorsAndThreshold,
    },
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MultisigIsmConfig {
    #[serde(rename = "type")]
    pub module_type: u8,
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

pub(crate) fn deploy_multisig_ism_message_id(
    ctx: &mut Context,
    built_so_dir: &Path,
    use_existing_keys: bool,
    key_dir: &Path,
) -> Pubkey {
    let (keypair, keypair_path) = create_and_write_keypair(
        key_dir,
        "hyperlane_sealevel_multisig_ism_message_id-keypair.json",
        use_existing_keys,
    );
    let program_id = keypair.pubkey();

    deploy_program(
        ctx.payer_keypair_path(),
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
        ctx.payer_pubkey,
    )
    .unwrap();

    ctx.new_txn().add(instruction).send_with_payer();

    println!("Initialized Multisig ISM Message ID ");

    program_id
}

pub(crate) fn configure_multisig_ism_message_id(
    ctx: &mut Context,
    program_id: Pubkey,
    multisig_config_file_path: &Path,
    chain_config_path: &Path,
) {
    let multisig_config_file =
        File::open(multisig_config_file_path).expect("Failed to open config file");
    let multisig_configs: HashMap<String, MultisigIsmConfig> =
        serde_json::from_reader(multisig_config_file).expect("Failed to read config file");

    let chain_config_file = File::open(chain_config_path).unwrap();
    let chain_configs: HashMap<String, ChainMetadata> =
        serde_json::from_reader(chain_config_file).unwrap();

    for (chain_name, multisig_ism_config) in multisig_configs {
        println!(
            "Configuring Multisig ISM Message ID for chain {} and config {:?}",
            chain_name, multisig_ism_config
        );
        let chain_config = chain_configs.get(&chain_name).unwrap();

        let (domain_data_key, _domain_data_bump) = Pubkey::find_program_address(
            domain_data_pda_seeds!(chain_config.domain_id()),
            &program_id,
        );

        let domain_data_account = ctx
            .client
            .get_account_with_commitment(&domain_data_key, ctx.commitment)
            .expect("Failed to get domain data account")
            .value;

        let matches = if let Some(domain_data_account) = domain_data_account {
            let domain_data = DomainDataAccount::fetch(&mut &domain_data_account.data[..])
                .unwrap()
                .into_inner();
            let expected_validator_set =
                HashSet::<H160>::from_iter(multisig_ism_config.validators.iter().cloned());
            let actual_validator_set = HashSet::<H160>::from_iter(
                domain_data
                    .validators_and_threshold
                    .validators
                    .iter()
                    .cloned(),
            );

            expected_validator_set == actual_validator_set
                && multisig_ism_config.threshold == domain_data.validators_and_threshold.threshold
        } else {
            false
        };

        if !matches {
            set_validators_and_threshold(
                ctx,
                program_id,
                chain_config.domain_id(),
                multisig_ism_config.into(),
            );
        }
    }
}

pub(crate) fn set_validators_and_threshold(
    ctx: &mut Context,
    program_id: Pubkey,
    domain: u32,
    validators_and_threshold: ValidatorsAndThreshold,
) {
    let (access_control_pda_key, _access_control_pda_bump) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    let (domain_data_pda_key, _domain_data_pda_bump) =
        Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

    let ixn = MultisigIsmMessageIdInstruction::SetValidatorsAndThreshold(Domained {
        domain,
        data: validators_and_threshold.clone(),
    });

    // Accounts:
    // 0. `[signer]` The access control owner and payer of the domain PDA.
    // 1. `[]` The access control PDA account.
    // 2. `[writable]` The PDA relating to the provided domain.
    // 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
    let accounts = vec![
        AccountMeta::new(ctx.payer_pubkey, true),
        AccountMeta::new_readonly(access_control_pda_key, false),
        AccountMeta::new(domain_data_pda_key, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];

    let set_instruction = Instruction {
        program_id,
        data: ixn.encode().unwrap(),
        accounts,
    };
    ctx.new_txn()
        .add_with_description(
            set_instruction,
            format!(
                "Set for remote domain {} validators and threshold: {:?}",
                domain, validators_and_threshold
            ),
        )
        .send_with_payer();
}
