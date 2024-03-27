use std::convert::TryFrom;
use std::fmt::{self, Display};

mod chain;
mod cli;
mod eth;
mod matching_list;

use clap::Parser;
use cli::{Cli, Commands};
use eth::RpcClient;
use matching_list::MatchingList;

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
            pretty_print(format!(
                "Sending message from {} to {}",
                origin_chain, destination_chain
            ));
            let mut client = RpcClient::try_from(origin_chain)?;
            // Try and get the private key from the environment
            let private_key = match args.private_key {
                Some(pk) => pk,
                None => {
                    pretty_print("No private key provided! Please provide a private key using the --private-key flag");
                    return Ok(());
                }
            };

            client.with_signer(private_key)?;

            let receipt = client
                .send(
                    mailbox_address,
                    destination_chain.chain_id(),
                    recipient_address,
                    message_body.into(),
                )
                .await?;

            let tx_hash = receipt.transaction_hash;
            pretty_print(format!("Message sent! Transaction hash: {}", tx_hash));
        }
        Commands::Listen {
            origin_chain,
            mailbox_address,
            matching_list,
        } => {
            pretty_print(format!("Listening for messages on {}", origin_chain));
            pretty_print(format!("Mailbox address: {}", mailbox_address));
            let matching_list = serde_json::from_str::<MatchingList>(&matching_list)?;
            pretty_print(format!("Matching list: {}", matching_list));
            let client = RpcClient::try_from(origin_chain)?;
            // NOTE: ideally we would stream out hyperlane messages as thet come in here.
            // I had trouble satisfying the compiler, so I'm making due with this solution for now.
            client
                .listen(mailbox_address, matching_list, |message| {
                    pretty_print(format!("Message received: {}", message));
                })
                .await?;
        }
    }
    Ok(())
}

fn capture_error<T>(result: Result<T, AppError>) {
    match result {
        Ok(_) => {}
        Err(e) => {
            eprintln!("{}", e);
        }
    }
}

fn pretty_print<T: Display>(value: T) {
    let bullet = "•";
    println!("{} {}", bullet, value);
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    Chain(#[from] chain::ChainError),
    RpcClient(#[from] eth::RpcClientError),
    InvalidMatchingList(#[from] serde_json::Error),
}

impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let error_message = format!("{:?}", self);
        let red = "\x1b[31;1m"; // Bright red
        let reset = "\x1b[0m"; // Reset to default color

        // ASCII art for visual impact (optional)
        let skull = "
        ☠️ ☠️ ☠️☠️☠️☠️☠️ ☠️ ☠️ ☠️ ☠️ ☠️ ☠️ ☠️ ☠️
        ";

        write!(
            f,
            "{}{}{}\n{}{}\n{}{}{}\n{}",
            red,
            skull,
            reset, // Skull in red
            red,
            error_message, // Error message in red
            reset,         // Reset color
            red,
            skull,
            reset
        )
    }
}
