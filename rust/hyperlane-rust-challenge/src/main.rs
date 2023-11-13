use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use ethers::abi::AbiEncode;
use ethers::{
    core::rand,
    providers::{Http, Provider},
    signers::LocalWallet,
    types::{Address, Bytes, H160, H256},
};
use query::Query;
use sender::Sender;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use utils::{MAILBOX, PROVIDER};

mod models;
mod query;
mod sender;
mod utils;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Dispatch {
    pub id: H256,
    pub origin: u32,
    pub sender: H160,
    pub destination: u32,
    pub receiver: H160,
    pub message: String,
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[arg(short, long)]
    provider: String,
    #[arg(short, long)]
    mailbox: Address,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand, Debug)]
pub enum Commands {
    Send {
        #[arg(long)]
        id: u32,
        #[arg(short, long)]
        destination_address: Address,
        #[arg(short, long)]
        message: Bytes,
        #[arg(long)]
        igp: Address,
    },
    Search {
        #[arg(long)]
        from: u64,
        #[arg(short, long)]
        to: Option<u64>,
        #[arg(long)]
        sender_filter: Option<String>,
        #[arg(long)]
        receiver_id_filter: Option<u32>,
        #[arg(long)]
        chain_destination_filter: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    let args = Args::parse();
    PROVIDER
        .set(Provider::<Http>::try_from(args.provider)?)
        .unwrap();
    MAILBOX.set(args.mailbox).unwrap();

    let private_key = match env::var("ETH_PRIVATE_KEY") {
        Ok(key) => key.parse::<LocalWallet>()?,
        Err(_) => {
            let wallet = LocalWallet::new(&mut rand::thread_rng());
            let private_key_hex = format!("{:x}", wallet.signer().to_bytes());

            fs::write(".env", format!("ETH_PRIVATE_KEY={}", private_key_hex))?;
            private_key_hex.parse::<LocalWallet>()?
        }
    };
    match args.command {
        Commands::Send {
            id,
            destination_address,
            message,
            igp,
        } => {
            let receiver_bytes_vec = AbiEncode::encode(H256::from(destination_address));
            if receiver_bytes_vec.len() == 32 {
                let receiver_bytes: [u8; 32] = receiver_bytes_vec.try_into().unwrap();
                Sender::dispatch_message(private_key, id, receiver_bytes, message, igp).await?;
            } else {
                bail!("Encodint bytes to len 32 Failed");
            }
        }
        Commands::Search {
            from,
            to,
            sender_filter,
            receiver_id_filter,
            chain_destination_filter,
        } => {
            Query::events_in_range(
                from,
                to,
                sender_filter,
                receiver_id_filter,
                chain_destination_filter,
            )
            .await?;
        }
    }
    Ok(())
}
