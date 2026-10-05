//! Two-phase, operator-driven repair of halted EVM scraper history.

#![forbid(unsafe_code)]

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use ethers::providers::{Http, Provider};
use eyre::{ensure, Result};
use sea_orm::{ConnectOptions, Database};

#[path = "../repair/mod.rs"]
mod repair;

#[derive(Parser)]
#[command(about = "Plan and apply a halted EVM scraper history repair")]
struct Args {
    // Environment-only credentials: never serialized into plans or archives.
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read-only: find a retained canonical ancestor and inventory the rewind.
    Inspect {
        #[arg(long)]
        domain: u32,
        /// Maximum distance below saved indexed height to search.
        #[arg(long)]
        max_rewind: u64,
        #[arg(long)]
        out: PathBuf,
        /// Bound the total archived rows and memory used by inspection/application.
        #[arg(long, default_value_t = 100_000)]
        max_rows: usize,
    },
    /// Apply a reviewed plan. All scraper writers must remain stopped.
    Apply {
        #[arg(long)]
        plan: PathBuf,
        /// New local file; fsynced before any history is deleted. Never overwritten.
        #[arg(long)]
        archive: PathBuf,
        /// Acknowledge stopping ALL scraper deployments sharing this database.
        #[arg(long, required = true)]
        writers_stopped: bool,
        /// Every scraper database login role; repeat for shared environments.
        #[arg(long, required = true)]
        writer_role: Vec<String>,
        /// Incident/runbook reference recording consumer pause, reset and replay.
        #[arg(long)]
        consumer_recovery_reference: String,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut options = ConnectOptions::new(std::env::var("DATABASE_URL")?);
    options.max_connections(1).sqlx_logging(false);
    let db = Database::connect(options).await?;
    let rpc = Provider::<Http>::try_from(std::env::var("REPAIR_RPC_URL")?)?;
    match args.command {
        Command::Inspect {
            domain,
            max_rewind,
            out,
            max_rows,
        } => {
            let plan = repair::inspect(&db, &rpc, domain, max_rewind, max_rows).await?;
            repair::write_new(&out, &plan)?;
            println!("{}", serde_json::to_string_pretty(&plan)?);
        }
        Command::Apply {
            plan,
            archive,
            writers_stopped,
            writer_role,
            consumer_recovery_reference,
        } => {
            ensure!(writers_stopped, "Stop every scraper writer first");
            let plan = serde_json::from_reader(std::fs::File::open(plan)?)?;
            repair::apply(
                &db,
                &rpc,
                &plan,
                &archive,
                &writer_role,
                &consumer_recovery_reference,
            )
            .await?;
            println!("Repair committed. Keep consumers paused until their recorded reset/replay is complete. Restart the scraper and verify indexed/confirmed progress and canonical events. Archive: {}", archive.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_requires_writer_acknowledgement_and_consumer_reference() {
        let arguments = [
            "scraper-repair",
            "apply",
            "--plan",
            "plan.json",
            "--archive",
            "archive.json",
            "--writer-role",
            "scraper",
            "--consumer-recovery-reference",
            "incident/123",
        ];
        assert!(Args::try_parse_from(arguments).is_err());
        assert!(Args::try_parse_from(arguments.into_iter().chain(["--writers-stopped"])).is_ok());
        assert!(Args::try_parse_from([
            "scraper-repair",
            "apply",
            "--plan",
            "plan.json",
            "--archive",
            "archive.json",
            "--writers-stopped",
            "--writer-role",
            "scraper"
        ])
        .is_err());
    }
}
