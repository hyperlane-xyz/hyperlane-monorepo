use clap::{command, Parser, Subcommand};
use ethers_core::types::Address;

use crate::chain::Chain;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Cli {
    // TODO: Not needed for all commands
    //  Should be prompted for if not provided
    #[clap(long, short, env = "HYPERLANE_PRIVATE_KEY")]
    pub private_key: Option<String>,

    #[clap(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Sends a message via Hyperlane
    Send {
        // TOOD: Verbose error messages for describing what chains are supported
        #[clap(long, short, env = "HYPERLANE_ORIGIN_CHAIN")]
        origin_chain: Chain,
        #[clap(long, short, env = "HYPERLANE_DESTINATION_CHAIN")]
        destination_chain: Chain,
        #[clap(long, short, env = "HYPERLANE_MAILBOX_ADDRESS")]
        mailbox_address: Address,
        #[clap(long, short, env = "HYPERLANE_DESTINATION_ADDRESS")]
        recipient_address: Address,
        #[clap(long)]
        message_body: String,
    },
    /// Searches for messages sent from a specified chain
    Listen {
        #[clap(long, short, env = "HYPERLANE_ORIGIN_CHAIN")]
        origin_chain: Chain,
        #[clap(long, short, env = "HYPERLANE_MAILBOX_ADDRESS")]
        mailbox_address: Address,
        // TODO: work on the typing for this so we can parse this from the command line
        #[clap(long, env = "HYPERLANE_MATCHING_LIST")]
        matching_list: String,
    },
}
