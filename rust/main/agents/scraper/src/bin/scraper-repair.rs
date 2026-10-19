//! Two-phase, operator-driven repair of halted scraper history on every VM.

#![forbid(unsafe_code)]

use std::path::PathBuf;

use async_trait::async_trait;
use clap::{Parser, Subcommand};
use ethers::providers::{Http, Provider};
use eyre::{ensure, Result};
use hyperlane_base::settings::{parser::RawAgentConf, ChainConnectionConf, Settings};
use hyperlane_core::{
    config::{ConfigPath, FromRawConf},
    ContractLocator,
};
use hyperlane_ethereum::{BuildableWithProvider, ConnectionConf};
use sea_orm::{ConnectOptions, Database};

#[path = "../repair/mod.rs"]
mod repair;

#[derive(Parser)]
#[command(about = "Plan and apply a halted scraper history repair on any supported VM")]
struct Args {
    /// Agent JSON config with the same chain providers/contracts as the scraper.
    #[arg(long, global = true, requires = "chain")]
    config: Option<PathBuf>,
    /// Chain name in --config. Without these flags, use the legacy EVM RPC env.
    #[arg(long, global = true, requires = "config")]
    chain: Option<String>,
    // Environment-only credentials: never serialized into plans or archives.
    #[command(subcommand)]
    command: Command,
}

struct EvmRepairBuilder;

#[async_trait]
impl BuildableWithProvider for EvmRepairBuilder {
    type Output = Box<dyn repair::RepairSource>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: ethers::providers::Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        _locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(provider)
    }
}

async fn source(args: &Args) -> Result<Box<dyn repair::RepairSource>> {
    let (Some(path), Some(chain)) = (&args.config, &args.chain) else {
        return Ok(Box::new(Provider::<Http>::try_from(std::env::var(
            "REPAIR_RPC_URL",
        )?)?));
    };
    let raw: RawAgentConf = serde_json::from_reader(std::fs::File::open(path)?)?;
    let filter = std::collections::HashSet::from([chain.as_str()]);
    let settings =
        Settings::from_config_filtered(raw, &ConfigPath::default(), Some(&filter), "scraper")?;
    let domain = settings.lookup_domain(chain)?;
    let conf = settings.chain_setup(&domain)?;
    let metrics = settings.metrics("scraper-repair")?;
    if let ChainConnectionConf::Ethereum(connection) = &conf.connection {
        return conf
            .build_ethereum(
                connection,
                &ContractLocator {
                    domain: &domain,
                    address: conf.addresses.mailbox,
                },
                &metrics,
                EvmRepairBuilder,
            )
            .await;
    }
    Ok(Box::new(repair::ProtocolSource {
        provider: conf.build_provider(&metrics).await?,
        contracts: [
            conf.addresses.mailbox,
            conf.addresses.merkle_tree_hook,
            conf.addresses.interchain_gas_paymaster,
        ],
    }))
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
    let rpc = source(&args).await?;
    let mut options = ConnectOptions::new(std::env::var("DATABASE_URL")?);
    options.max_connections(1).sqlx_logging(false);
    let db = Database::connect(options).await?;
    match args.command {
        Command::Inspect {
            domain,
            max_rewind,
            out,
            max_rows,
        } => {
            let plan = repair::inspect(&db, rpc.as_ref(), domain, max_rewind, max_rows).await?;
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
                rpc.as_ref(),
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
    fn configured_repair_requires_config_and_chain_together() {
        let inspect = [
            "scraper-repair",
            "inspect",
            "--domain",
            "1",
            "--max-rewind",
            "10",
            "--out",
            "plan.json",
        ];
        assert!(Args::try_parse_from(inspect).is_ok());
        assert!(
            Args::try_parse_from(inspect.into_iter().chain(["--config", "agent.json"])).is_err()
        );
        assert!(
            Args::try_parse_from(inspect.into_iter().chain(["--chain", "solanamainnet"])).is_err()
        );
        assert!(Args::try_parse_from(inspect.into_iter().chain([
            "--config",
            "agent.json",
            "--chain",
            "solanamainnet"
        ]))
        .is_ok());
    }

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
