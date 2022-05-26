use structopt::StructOpt;

use crate::subcommands::prove::ProveCommand;

#[derive(StructOpt)]
pub enum Commands {
    /// Prove a message on an inbox for a given leaf index
    Prove(ProveCommand),
}
