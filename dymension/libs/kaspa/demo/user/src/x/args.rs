use super::deposit::DepositArgs;
use clap::{Args, Parser, Subcommand};
use hyperlane_core::H256;
use kaspa_consensus_core::network::NetworkId;
use std::str::FromStr;

#[derive(Parser, Debug)]
#[command(
    name = "demo-user",
    author,
    version, // `version()` is automatically called by clap
    about = "Tools for users, validator operators, developers etc",
    subcommand_required = true,
    arg_required_else_help = true,
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Convert kaspa address (like kaspatest:pzlq49sp...y4za866ne90v7e6pyrfr) to HL address (like 0x000000000..0000000)
    Recipient(RecipientCli),
    /// Get the escrow address for some secp256k1 pub keys (like kaspatest:pzlq49spp6...66ne90v7e6pyrfr)
    Escrow(EscrowCli),
    /// Generate all the info needed for a validator (without escrow address)
    Validator(ValidatorCli),
    /// Generate all the info needed for a validator with a 1 of 1 multisig escrow
    #[clap(name = "validator-with-escrow")]
    ValidatorAndEscrow,
    /// Make a user deposit (to escrow)
    Deposit(DepositCli),
    /// Create a relayer
    Relayer,
    /// Simulate traffic
    #[clap(name = "sim")]
    SimulateTraffic(SimulateTrafficCli),
}

#[derive(Args, Debug)]
pub struct ValidatorCli {
    /// Generate more than one validator at a time
    #[arg(required = false, index = 1, default_value = "1")]
    pub n: u32,
}

#[derive(Args, Debug)]
pub struct EscrowCli {
    /// Comma separated list of pub keys
    #[arg(required = true, index = 1)]
    pub pub_keys: String,
    /// Required signatures
    #[arg(required = true, index = 2)]
    pub required_signatures: u8,
}

#[derive(Args, Debug)]
pub struct RecipientCli {
    /// The address to be converted
    #[arg(required = true, index = 1)]
    pub address: String,
}

#[derive(Args, Debug)]
/// Simulate/benchmark traffic on Kaspa and the Hub
/// Launches some tasks with amounts and times sampled from realistic (poisson and exponential) distribution.
/// Each task does a kaspa deposit to a new hub address, and then transfers back to a kaspa address.
/// In this way errors and latencies can be tracked
pub struct SimulateTrafficCli {
    /// The amount to fund each hub address with adym to pay fees on the withdrawal
    #[arg(long, required = true)]
    pub hub_fund_amount: u64,

    /// Filesystem dir to write logs/stats/debuf info from the run
    #[arg(long, required = true)]
    pub output_dir: String,

    /// Hex private key of hub account which has dym funds which can be used to pay fees on the withdrawals
    #[arg(long, required = true)]
    pub hub_whale_priv_key: String,

    /// Approx total time limit to run the simulation in seconds
    #[arg(long, required = true)]
    pub time_limit: u64,

    /// Approx kaspa budget to fund deposits, from the kaspa whale account (in sompi)
    #[arg(long, required = true)]
    pub budget: u64,

    /// Approx number of ops per minute to run. E.g. osmosis does 90 IBC transfers per minute
    #[arg(long, required = true)]
    pub ops_per_minute: u64,

    /// Minimum deposit amount in sompi
    #[arg(long, required = true)]
    pub min_deposit_sompi: u64,

    /// Kaspa HL domain
    #[arg(long, required = true)]
    pub domain_kas: u32,

    /// Kaspa HL token placeholder contract addr (e.g. 0x0000000000000000000000000000000000000000000000000000000000000000)
    #[arg(long, required = true)]
    pub token_kas_placeholder: H256,

    /// Hub HL domain
    #[arg(long, required = true)]
    pub domain_hub: u32,

    /// The HL Warp token ID for kaspa on the Hub
    #[arg(long, required = true)]
    pub token_hub: H256,

    /// Kaspa escrow address
    #[arg(long, required = true)]
    pub escrow_address: String,

    #[command(flatten)]
    pub wallet: WalletCli,

    #[arg(long, required = false, default_value = "false")]
    /// If true, just simply does one round trip and then exists, ignoring time and budget etc
    pub simple: bool,

    #[arg(long, required = true, default_value = "180")]
    /// The number of seconds to wait for the simulation to cancel
    pub cancel_wait: u64,
}

#[derive(Args, Debug, Clone)]
pub struct DepositCli {
    /// The escrow address (like kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr)
    #[arg(long, required = true)]
    pub escrow_address: String,

    /// The amount to deposit in sompi (like 100000)
    #[arg(long, required = true)]
    pub amount: String,

    /// The payload to deposit (hex without 0x prefix)
    #[arg(long, required = false, default_value = "")]
    pub payload: String,

    #[command(flatten)]
    pub wallet: WalletCli,
}

#[derive(Args, Debug, Clone)]
pub struct WalletCli {
    /// The wRPC url (like localhost:17210)
    #[arg(long("wrpc-url"), required = true)]
    pub rpc_url: String,

    /// The kaspa network id (like testnet-10)
    #[arg(long("network-id"), required = true)]
    // If you have a NetworkId type that implements `FromStr`, you can use it directly:
    // pub network_id: kaspa_consensus_core::network::NetworkId,
    pub network_id: String,

    /// Local kaspa wallet keychain secret (not private key)
    #[arg(long("wallet-secret"), required = true)]
    pub wallet_secret: String,

    /// Local kaspa wallet directory
    #[arg(long("wallet-dir"), required = false)]
    pub wallet_dir: Option<String>,
}

impl DepositCli {
    pub fn to_deposit_args(&self) -> DepositArgs {
        DepositArgs {
            escrow_address: self.escrow_address.clone(),
            amount: self.amount.clone(),
            payload: self.payload.clone(),
            network_id: NetworkId::from_str(&self.wallet.network_id).unwrap(),
            rpc_url: self.wallet.rpc_url.clone(),
            wallet_secret: self.wallet.wallet_secret.clone(),
            wallet_dir: self.wallet.wallet_dir.clone(),
        }
    }
}
