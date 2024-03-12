use std::convert::TryFrom;
use std::fmt::{self, Display};


mod chain;
mod cli;
mod eth;

use chain::{ChainError};
use clap::Parser;
use cli::{Cli, Commands};
use eth::{EthClient, EthClientError};

#[tokio::main]
async fn main() {
    // Run the app and capture any errors
    capture_error(run().await);
}

pub async fn run() -> Result<(), AppError> {
    let args = Cli::parse();

    match args.command {
        Commands::Send {
            origin_chain,
            destination_chain,
            mailbox_address,
            recipient_address,
            message_body,
        } => {
            let mut eth_client = EthClient::try_from(origin_chain)?;
            // Try and get the private key from the environment
            let private_key = match args.private_key {
                Some(pk) => pk,
                None => {
                    println!("No private key provided");
                    return Ok(());
                }
            };

            eth_client.with_signer(private_key)?;

            let receipt = eth_client
                .dispatch(
                    mailbox_address,
                    destination_chain.chain_id(),
                    recipient_address,
                    message_body.into(),
                )
                .await?;

            let tx_hash = receipt.transaction_hash;
            println!("Transaction hash: {:?}", tx_hash);
            // TODO: Listen for recieved message on target chain
        }
        _ => todo!(),
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    Chain(#[from] ChainError),
    EthClient(#[from] EthClientError),
}

fn capture_error<T>(result: Result<T, AppError>) {
    match result {
        Ok(_) => {}
        Err(e) => {
            eprintln!("{}", e);
        }
    }
}

// TODO: Make pretty
impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let error_message = format!("{:?}", self);
        let red = "\x1b[31;1m"; // Bright red
        let reset = "\x1b[0m"; // Reset to default color

        // ASCII art for visual impact (optional)
        let skull = "
        ☠️ ☠️ ☠️
        ";

        write!(
            f,
            "{}{}{}\n{}{}\n{}",
            red,
            skull,
            reset, // Skull in red
            red,
            error_message, // Error message in red
            reset          // Reset color
        )
    }
}
