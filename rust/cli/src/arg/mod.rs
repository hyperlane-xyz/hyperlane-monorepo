use clap::{Args, Subcommand};

#[derive(clap::Parser, Debug)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
pub struct CliArgs {
    /// RCP URL for chain to call
    #[clap()]
    pub url: String,

    /// Contract address as H160 hex string (40 characters), optionally prefixed with 0x
    #[clap()]
    pub contract: H160,

    /// Private key (optional, if needed to sign), as H256 hex string (64 characters), optionally prefixed with 0x
    #[clap(short, long, global = true)]
    pub key: Option<H256>,

    /// Origin chain identifier (unsigned integer). If not specified, chain will be queried for chain ID
    #[clap(short, long)]
    pub origin: Option<u32>,

    /// Action to perform on contract (dispatch, pay, query)
    #[command(subcommand)]
    pub command: CommandArgs,

    /// Show verbose output (including transaction logs)
    #[clap(short, long)]
    pub verbose: bool,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum CommandArgs {
    #[clap(about = "Test chain connection and take no further action")]
    Connect(ConnectArgs),

    #[clap(about = "Dispatch message to destination chain via Hyperlane mailbox contract")]
    Dispatch(DispatchArgs),

    #[clap(
        about = "Pay for gas of delivery on destination chain via Hyperlane gas paymaster contract"
    )]
    Pay(PayArgs),

    #[clap(about = "Query for Hyperlane messages sent from origin chain")]
    Query(QueryArgs),
}

mod dispatch;
pub use dispatch::*;

mod pay;
use hyperlane_core::{H160, H256};
pub use pay::*;

mod query;
pub use query::*;

#[derive(Args, Debug, PartialEq)]
pub struct ConnectArgs {}
