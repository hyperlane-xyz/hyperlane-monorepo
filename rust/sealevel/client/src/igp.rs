use std::str::FromStr;

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

use crate::{read_core_program_ids, Context, GasOverheadSubCmd, GetSetCmd, IgpCmd, IgpSubCmd};

pub(crate) fn process_igp_cmd(ctx: Context, cmd: IgpCmd) {
    match cmd.cmd {
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
