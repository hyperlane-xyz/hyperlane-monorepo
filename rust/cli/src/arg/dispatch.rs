use clap::Args;
use hyperlane_core::H160;
use std::path::PathBuf;

#[derive(Args, Debug, PartialEq)]
pub struct DispatchArgs {
    // /// Origin chain identifier (unsigned integer). If not specified, chain will be queried for chain ID
    // #[arg(short, long)]
    // pub origin: Option<u32>,
    /// Destination chain identifier (unsigned integer)
    #[arg()]
    pub dest: u32,

    /// Recipient contract address as H160 hex string (40 characters), optionally prefixed with 0x
    #[arg()]
    pub recipient: H160,

    /// Hex encoded message payload to send, optionally prefixed with 0x
    #[arg(short, long)]
    pub payload: Option<String>,

    /// Input file for message payload (bytes) to send. (Alternative to --payload, specify one or the other.)
    #[arg(short, long)]
    pub file: Option<PathBuf>,
    // TODO: Confirmations?
}
