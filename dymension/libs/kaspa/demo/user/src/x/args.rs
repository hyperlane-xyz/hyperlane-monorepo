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
    /// Validator management commands
    Validator {
        #[command(subcommand)]
        action: ValidatorAction,
    },
    /// Make a user deposit (to escrow)
    Deposit(DepositCli),
    /// Create a relayer
    Relayer,
    /// Simulate traffic
    #[clap(name = "sim")]
    SimulateTraffic(SimulateTrafficCli),
}

#[derive(Subcommand, Debug)]
pub enum ValidatorAction {
    /// Create new validator keys
    Create {
        #[command(subcommand)]
        backend: ValidatorBackend,
    },
}

#[derive(Subcommand, Debug)]
pub enum ValidatorBackend {
    /// Generate and store validator keys locally
    Local(ValidatorLocalArgs),

    /// Generate and store validator keys in AWS Secrets Manager
    Aws(ValidatorAwsArgs),
}

#[derive(Args, Debug)]
pub struct ValidatorLocalArgs {
    /// Number of validators to generate
    #[arg(short = 'n', long, default_value = "1")]
    pub count: u32,

    /// Optional: save output to JSON file
    #[arg(short, long)]
    pub output: Option<String>,
}

#[derive(Args, Debug)]
pub struct ValidatorAwsArgs {
    /// Secret path for storing the validator keys (e.g., /hyperlane/kaspa/validator-1)
    /// All validator key properties will be stored as an encrypted JSON object at this path
    #[arg(short, long)]
    pub path: String,

    /// AWS KMS symmetric key ID or ARN for encryption (must be SYMMETRIC_DEFAULT, not RSA/ECC)
    #[arg(long)]
    pub kms_key_id: String,
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

    /// Minimum deposit amount in sompi (must be at least 4000000000 = 40 KAS for withdrawals to work)
    #[arg(long, default_value = "4000000000")]
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

    /// Hub RPC URL (default: https://rpc-dymension-playground35.mzonder.com:443)
    #[arg(
        long,
        default_value = "https://rpc-dymension-playground35.mzonder.com:443"
    )]
    pub hub_rpc_url: String,

    /// Hub gRPC URL (default: https://grpc-dymension-playground35.mzonder.com:443)
    #[arg(
        long,
        default_value = "https://grpc-dymension-playground35.mzonder.com:443"
    )]
    pub hub_grpc_url: String,

    /// Hub chain ID (default: dymension_3405-1)
    #[arg(long, default_value = "dymension_3405-1")]
    pub hub_chain_id: String,

    /// Hub address prefix (default: dym)
    #[arg(long, default_value = "dym")]
    pub hub_prefix: String,

    /// Hub native denom (default: adym)
    #[arg(long, default_value = "adym")]
    pub hub_denom: String,

    /// Hub native token decimals (default: 18)
    #[arg(long, default_value = "18")]
    pub hub_decimals: u32,

    /// Kaspa REST API URL (default: https://api-tn10.kaspa.org/)
    #[arg(long, default_value = "https://api-tn10.kaspa.org/")]
    pub kaspa_rest_url: String,

    /// If true, just simply does one round trip and then exists, ignoring time and budget etc
    #[arg(long, default_value = "false")]
    pub simple: bool,

    /// The number of seconds to wait for the simulation to cancel (default: 180)
    #[arg(long, default_value = "180")]
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
