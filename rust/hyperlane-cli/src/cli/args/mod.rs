use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[command(subcommand)]
    pub command: Commands,

    #[arg(short, long, help = "Origin chain")]
    pub origin_chain: i32,

    #[arg(short, long, help = "Mailbox address")]
    pub mailbox_address: String,

    #[arg(short, long, help = "Ethereum RPC URL")]
    pub rpc_url: String,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Send message bytes to a destination address
    Send {
        #[arg(short, long, help = "Destination address")]
        address_destination: String,

        #[arg(short, long, help = "Destination chain")]
        chain_destination: i32,

        #[arg(short, long, help = "Message bytes")]
        bytes: String,

        #[arg(short, long, help = "Signing key")]
        private_key: String,
    },
    /// Query mailbox messages  
    Query {
        #[arg(short, long, help = "Matching list file")]
        matching_list_file: Option<String>,
        #[arg(short, long, help = "The amount of blocks to query messages from")]
        block_depth: Option<u32>,
        #[arg(short, long, help = "Output type; either json or table")]
        print_output_type: String,
    },
}

pub mod parse;
