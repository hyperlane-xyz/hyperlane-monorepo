use kaspa_core::kaspad_env::version;

use clap::{Arg, ArgAction, Command};

const NAME: &str = "demo";

pub fn cli() -> Command {
    Command::new(NAME)
        .about(format!(
            "{} ({}) v{}",
            env!("CARGO_PKG_DESCRIPTION"),
            NAME,
            version()
        ))
        .version(env!("CARGO_PKG_VERSION"))
        .arg(
            Arg::new("rpcserver")
                .long("rpcserver")
                .short('s')
                .value_name("rpcserver")
                .default_value("localhost:16210") // TODO: this is mainnet wprc
                .help("RPC server"),
        )
        .arg(
            Arg::new("wallet-secret")
                .long("wallet-secret")
                .short('w')
                .value_name("wallet-secret")
                .help("Wallet secret"),
        )
        .arg(
            Arg::new("only-deposit")
                .long("only-deposit")
                .short('d')
                .action(ArgAction::SetTrue)
                .help("Only deposit then exit."),
        )
        .arg(
            Arg::new("payload")
                .long("payload")
                .short('p')
                .value_name("payload")
                .help("Payload to send."),
        )
        .arg(
            Arg::new("escrow-address")
                .long("escrow-address")
                .short('e')
                .value_name("escrow-address")
                .help("Escrow address."),
        )
        .arg(
            Arg::new("amount")
                .long("amount")
                .short('a')
                .value_name("amount")
                .help("Amount to send."),
        )
}

pub struct Args {
    pub wallet_secret: Option<String>,
    pub rpc_server: String, // TODO: use
    pub only_deposit: bool,
    pub payload: Option<String>,
    pub escrow_address: Option<String>,
    pub amount: Option<u64>,
}

impl Args {
    pub fn parse() -> Self {
        let m = cli().get_matches();
        let only_deposit = m.get_flag("only-deposit");
        let amount = m
            .get_one::<String>("amount")
            .cloned()
            .map(|s| s.parse::<u64>().unwrap());
        Args {
            wallet_secret: m.get_one::<String>("wallet-secret").cloned(),
            rpc_server: m
                .get_one::<String>("rpcserver")
                .cloned()
                .unwrap_or("localhost:16210".to_owned()),
            only_deposit: only_deposit,
            payload: m.get_one::<String>("payload").cloned(),
            escrow_address: m.get_one::<String>("escrow-address").cloned(),
            amount: amount,
        }
    }
}
