use corelib::env::version;

use clap::{Arg, Command};

const NAME: &str = "demo-multisig";

pub fn cli() -> Command {
    Command::new(NAME)
        .about(format!(
            "{} ({}) v{}",
            env!("CARGO_PKG_DESCRIPTION"),
            NAME,
            version()
        ))
        .version(version())
        .arg(
            Arg::new("wallet-secret")
                .long("wallet-secret")
                .short('w')
                .value_name("wallet-secret")
                .help("Wallet secret"),
        )
}

pub struct Args {
    pub wallet_secret: Option<String>,
}

impl Args {
    pub fn parse() -> Self {
        let m = cli().get_matches();
        Args {
            wallet_secret: m.get_one::<String>("wallet-secret").cloned(),
        }
    }
}
