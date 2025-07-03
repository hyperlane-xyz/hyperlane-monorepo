use super::deposit::DepositArgs;
use clap::{Args, Parser, Subcommand};
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
    /// Convert address
    Recipient(RecipientArgs),

    /// Generate all the info needed for a validator with a 1 of 1 multisig escrow
    Validator, // This subcommand takes no arguments

    /// Make a user deposit
    Deposit(DepositArgsCli),
}

#[derive(Args, Debug)]
pub struct RecipientArgs {
    /// The address to be converted
    #[arg(required = true, index = 1)]
    pub address: String,
}

#[derive(Args, Debug, Clone)]
pub struct DepositArgsCli {
    /// The escrow address (like kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr)
    #[arg(long, required = true)]
    pub escrow_address: String,

    /// The amount to deposit in sompi (like 100000)
    #[arg(long, required = true)]
    pub amount: String,

    /// The payload to deposit (hex without 0x prefix)
    #[arg(long, required = true)]
    pub payload: String,

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
}

impl DepositArgsCli {
    pub fn to_deposit_args(&self) -> DepositArgs {
        DepositArgs {
            escrow_address: self.escrow_address.clone(),
            amount: self.amount.clone(),
            payload: self.payload.clone(),
            network_id: NetworkId::from_str(&self.network_id).unwrap(),
            rpc_url: self.rpc_url.clone(),
            wallet_secret: self.wallet_secret.clone(),
        }
    }
}
