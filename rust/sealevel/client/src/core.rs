use borsh::BorshDeserialize;
use hyperlane_sealevel_mailbox::protocol_fee::ProtocolFee;
use serde::{Deserialize, Serialize};

use solana_program::pubkey::Pubkey;
use solana_sdk::{compute_budget, compute_budget::ComputeBudgetInstruction};

use std::{fs::File, path::Path};

use crate::cmd_utils::get_compute_unit_price_micro_lamports_for_chain_name;
use crate::ONE_SOL_IN_LAMPORTS;
use crate::{
    artifacts::{read_json, write_json},
    cmd_utils::{create_new_directory, deploy_program},
    multisig_ism::deploy_multisig_ism_message_id,
    Context, CoreCmd, CoreDeploy, CoreSubCmd,
};
use hyperlane_core::H256;

pub(crate) fn adjust_gas_price_if_needed(chain_name: &str, ctx: &mut Context) {
    if chain_name.eq("solanamainnet") {
        let compute_unit_price = get_compute_unit_price_micro_lamports_for_chain_name(chain_name);
        let mut initial_instructions = ctx.initial_instructions.borrow_mut();
        for i in initial_instructions.iter_mut() {
            if i.instruction.program_id != compute_budget::id() {
                continue;
            }
            if let Ok(compute_budget_instruction) =
                ComputeBudgetInstruction::try_from_slice(&i.instruction.data)
            {
                if matches!(
                    compute_budget_instruction,
                    ComputeBudgetInstruction::SetComputeUnitPrice { .. }
                ) {
                    // The compute unit price has already been set, so we override it and return early
                    i.instruction =
                        ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price);
                    return;
                }
            }
        }

        initial_instructions.push(
            (
                ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price),
                Some(format!(
                    "Set compute unit price to {} micro-lamports",
                    compute_unit_price
                )),
            )
                .into(),
        );
    }
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ProtocolFeeConfig {
    max_protocol_fee: u64,
    fee: u64,
    #[serde(with = "crate::serde::serde_option_pubkey")]
    beneficiary: Option<Pubkey>,
}

impl Default for ProtocolFeeConfig {
    fn default() -> Self {
        Self {
            max_protocol_fee: ONE_SOL_IN_LAMPORTS,
            fee: 0,
            beneficiary: None,
        }
    }
}

pub(crate) fn process_core_cmd(mut ctx: Context, cmd: CoreCmd) {
    match cmd.cmd {
        CoreSubCmd::Deploy(core) => {
            adjust_gas_price_if_needed(core.chain.as_str(), &mut ctx);

            let environments_dir =
                create_new_directory(&core.env_args.environments_dir, &core.env_args.environment);
            let chain_dir = create_new_directory(&environments_dir, &core.chain);
            let core_dir = create_new_directory(&chain_dir, "core");
            let key_dir = create_new_directory(&core_dir, "keys");

            let ism_program_id = deploy_multisig_ism_message_id(
                &mut ctx,
                &core.built_so_dir,
                &key_dir,
                core.local_domain,
            );

            let mailbox_program_id =
                deploy_mailbox(&mut ctx, &core, &key_dir, ism_program_id, core.local_domain);

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
    local_domain: u32,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_mailbox",
        core.built_so_dir
            .join("hyperlane_sealevel_mailbox.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Mailbox at program ID {}", program_id);

    let protocol_fee_config = core
        .protocol_fee_config_file
        .as_deref()
        .map(|p| {
            let file = File::open(p).expect("Failed to open oracle config file");
            serde_json::from_reader::<_, ProtocolFeeConfig>(file)
                .expect("Failed to parse oracle config file")
        })
        .unwrap_or_default();

    let protocol_fee_beneficiary = protocol_fee_config.beneficiary.unwrap_or(ctx.payer_pubkey);

    // Initialize
    let instruction = hyperlane_sealevel_mailbox::instruction::init_instruction(
        program_id,
        core.local_domain,
        default_ism,
        protocol_fee_config.max_protocol_fee,
        ProtocolFee {
            fee: protocol_fee_config.fee,
            beneficiary: protocol_fee_beneficiary,
        },
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
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_validator_announce",
        core.built_so_dir
            .join("hyperlane_sealevel_validator_announce.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        core.local_domain,
    )
    .unwrap();

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

/// Deploys the IGP program and initializes the zero salt IGP and overhead IGP accounts.
/// Configuration of gas oracles is expected to be done separately.
fn deploy_igp(ctx: &mut Context, core: &CoreDeploy, key_dir: &Path) -> (Pubkey, Pubkey, Pubkey) {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_igp",
        core.built_so_dir
            .join("hyperlane_sealevel_igp.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        core.local_domain,
    )
    .unwrap();

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

#[cfg(test)]
mod test {
    use solana_program::pubkey::Pubkey;

    #[test]
    fn test_protocol_fee_serialization() {
        let protocol_fee_config = super::ProtocolFeeConfig {
            max_protocol_fee: 100,
            fee: 10,
            beneficiary: Some(Pubkey::new_unique()),
        };
        let json_serialized = serde_json::to_string(&protocol_fee_config).unwrap();
        assert_eq!(
            json_serialized,
            r#"{"maxProtocolFee":100,"fee":10,"beneficiary":"1111111QLbz7JHiBTspS962RLKV8GndWFwiEaqKM"}"#
        );
        let deserialized: super::ProtocolFeeConfig =
            serde_json::from_str(&json_serialized).unwrap();
        assert_eq!(deserialized, protocol_fee_config);
    }
}
