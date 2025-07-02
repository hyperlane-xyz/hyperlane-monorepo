use std::str::FromStr;

use super::deposit::DepositArgs;
use clap::{Arg, Command};
use kaspa_consensus_core::network::NetworkId;

pub fn common_args(cmd: Command) -> Command {
    cmd.arg(
        Arg::new("verbose")
            .short('v')
            .long("verbose")
            .help("Enable verbose output")
            .action(clap::ArgAction::SetTrue),
    )
}

pub fn cli() -> Command {
    Command::new("user")
        .about("User tools")
        .version("1.0")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(
            common_args(Command::new("recipient").about("Convert address")).arg(
                Arg::new("ADDRESS")
                    .help("The address to be converted")
                    .required(true)
                    .index(1),
            ),
        )
        .subcommand(common_args(
            Command::new("validator").about("Validator tools"),
        ))
        .subcommand(
            common_args(Command::new("deposit").about("Make a user deposit"))
                /*
                need args for:
                wallet secret, network id, rpc url, payload string, escrow addr, amt
                 */
                .arg(
                    Arg::new("wallet-secret")
                        .help("The wallet secret")
                        .required(true)
                        .index(1),
                )
                .arg(
                    Arg::new("amount")
                        .help("The amount to deposit")
                        .required(true)
                        .index(1),
                )
                .arg(
                    Arg::new("payload")
                        .help("The payload to deposit")
                        .required(true)
                        .index(1),
                )
                .arg(
                    Arg::new("escrow-address")
                        .help("The escrow address")
                        .required(true)
                        .index(1),
                )
                .arg(
                    Arg::new("network-id")
                        .help("The network id")
                        .required(true)
                        .index(1),
                )
                .arg(
                    Arg::new("rpc-url")
                        .help("The rpc url")
                        .required(true)
                        .index(1),
                ),
        )
}

impl DepositArgs {
    pub fn parse() -> Self {
        let m = cli().get_matches();
        let network_id = m.get_one::<String>("network-id").unwrap().clone();
        let network_id = NetworkId::from_str(&network_id).unwrap();
        DepositArgs {
            wallet_secret: m.get_one::<String>("wallet-secret").unwrap().clone(),
            amount: m.get_one::<String>("amount").unwrap().clone(),
            payload: m.get_one::<String>("payload").unwrap().clone(),
            escrow_address: m.get_one::<String>("escrow-address").unwrap().clone(),
            network_id: network_id,
            rpc_url: m.get_one::<String>("rpc-url").unwrap().clone(),
        }
    }
}
