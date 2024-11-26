use clap::{Parser, Subcommand};
use eyre::Result;

mod search;
mod send;

use search::SearchArgs;
use send::SendArgs;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Send(args) => {
            args.send_message().await?;
        }
        Command::Search(args) => {
            args.search().await?;
        }
    }
    Ok(())
}

#[derive(Parser)]
#[clap(version, about)]
// CLI to interact with the Hyperlane protocol
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[clap(name = "send")]
    Send(SendArgs),
    #[clap(name = "search")]
    Search(SearchArgs),
}
