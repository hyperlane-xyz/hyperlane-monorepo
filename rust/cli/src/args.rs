use clap::{Parser, Subcommand};
use url::Url;

/// Simple program to greet a person
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    #[command(subcommand)]
    pub command: Op,
}

#[derive(Subcommand, Debug)]
pub enum Op {
    /// Send hyperlane message
    Send {
        /// Address of the mailbox contract deployed both on the origin and destination chain
        #[arg(short, long)]
        mailbox_addr: String,

        /// Origin chain address
        #[arg(value_parser = clap::value_parser!(Url), short, long)]
        origin_rpc: Url,

        /// Url of the destination chain
        #[arg(value_parser = clap::value_parser!(Url), short, long)]
        destination_rpc: Url,

        /// Address of the recipient of the hyperlane message
        #[arg(short, long)]
        recipient: String,

        /// Sender address to where the pay gas fees from for the transaction
        #[arg(short, long)]
        sender: String,
    },
    /// Check all hyperlane messages for given chain
    Check {
        /// Address of the mailbox contract deployed both on the origin and destination chain
        #[arg(short, long)]
        mailbox_addr: String,

        /// rpc url of the chain we want to check hyperlane messages at
        #[arg(short, long)]
        origin_rpc: Url,
    },
}
