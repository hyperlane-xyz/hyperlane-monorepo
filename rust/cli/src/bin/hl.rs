//! # Hyperlane CLI
//!
//! The `hl` command-line application allows you to send Hyperlane messages via a Hyperlane mailbox.
//! This application provides the ability to test chain connections, dispatch messages, pay for gas,
//! query messages, and fetch help details.
//!
//! # Usage
//! ```
//! hl [OPTIONS] <URL> <CONTRACT> <COMMAND>
//! ```
//!
//! # Commands
//! - `connect`: Tests the connection to the chain and does not perform any further action.
//! - `dispatch`: Dispatches a message to the destination chain via the Hyperlane mailbox contract.
//! - `pay`: Pays for the gas of delivery on the destination chain via the Hyperlane gas paymaster contract.
//! - `query`: Queries for Hyperlane messages that were sent from the origin chain.
//! - `help`: Prints this help message or the help for the provided subcommands.
//!
//! # Arguments
//! - `<URL>`: The RPC URL for the chain to call.
//! - `<CONTRACT>`: The contract address as an H160 hex string (40 characters). This may optionally be prefixed with 0x.
//!
//! # Options
//! - `-k, --key <KEY>`: Provides a private key when needed for signing. This should be an H256 hex string
//! (64 characters) and may optionally be prefixed with 0x.
//! - `-v, --verbose`: When this option is used, the output will include verbose details, such as transaction logs.
//! - `-h, --help`: Prints help details.
//! - `-V, --version`: Prints the version number of the application.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::sync::Arc;

use clap::Parser;
use cli::action;
use cli::arg::CliArgs;
use cli::core;
use cli::param::CommandParams;
use color_eyre::{eyre::eyre, Result};
use hyperlane_base::setup_error_handling;

/// # High level execution flow
///
/// Command line arguments are parsed using the clap crate into [CommandArgs](cli::arg::CommandArgs).
///
/// The CommandArgs struct is then converted into a [CommandParams](cli::param::CommandParams) struct.
/// * Syntactic correctness of the arguments is checked without connecting to the chain.
///
/// Parameters are then passed to an execution function (for example to dispatch or query).
/// * Uses a builder pattern that interacts with the chain to resolve missing parameters.
/// * When the builder is complete, the command is executed and the result is returned.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    setup_error_handling()?;

    let args = CliArgs::parse();

    let (provider, chain_id) = core::get_provider(args.url.clone()).await?;

    let params: &CommandParams = &args.command.try_into()?;
    if let CommandParams::Query(params) = params {
        action::query(Arc::clone(&provider), chain_id, args.contract, params).await?;
        return Ok(());
    }

    if let CommandParams::Connect = params {
        return Ok(());
    }

    let sender_wallet = core::get_wallet(
        args.key.ok_or_else(|| eyre!("No signing key provided"))?,
        chain_id,
    )?;
    let client = core::get_client(provider, sender_wallet.clone());

    match &params {
        CommandParams::Dispatch(params) => {
            action::dispatch(
                client,
                args.contract,
                params.dest_id,
                params.recipient_address,
                params.payload.clone(),
                args.verbose,
            )
            .await?
        }
        CommandParams::Pay(params) => {
            action::pay(
                sender_wallet,
                client,
                args.contract,
                params.msg_id,
                params.dest_id,
                params.gas,
                args.verbose,
            )
            .await?
        }
        CommandParams::Query(_) => unimplemented!("Should be unreachable"),
        CommandParams::Connect => unimplemented!("Should be unreachable"),
    }

    Ok(())
}
