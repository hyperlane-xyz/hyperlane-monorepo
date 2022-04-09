use structopt::StructOpt;

use crate::subcommands::{db_state::DbStateCommand, prove::ProveCommand};

#[derive(StructOpt)]
pub enum Commands {
    /// Prove a message on an inbox for a given leaf index
    Prove(ProveCommand),
    /// Print the processor's db state
    DbState(DbStateCommand),
}
