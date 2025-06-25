use kaspa_core::kaspad_env::version;

use clap::{Arg, Command};

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
            Arg::new("private-key")
                .long("private-key")
                .short('k')
                .value_name("private-key")
                .help("Private key in hex format"),
        )
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
}

pub struct Args {
    pub private_key: Option<String>, // TODO: not used
    pub wallet_secret: Option<String>,
    pub rpc_server: String, // TODO: use
}

impl Args {
    pub fn parse() -> Self {
        let m = cli().get_matches();
        Args {
            private_key: m.get_one::<String>("private-key").cloned(),
            wallet_secret: m.get_one::<String>("wallet-secret").cloned(),
            rpc_server: m
                .get_one::<String>("rpcserver")
                .cloned()
                .unwrap_or("localhost:16210".to_owned()),
        }
    }
}
