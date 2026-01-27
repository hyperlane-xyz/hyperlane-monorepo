use clap::Parser;
use x::args::{Cli, Commands, SimulateTrafficCli, ValidatorAction, ValidatorBackend};

mod sim;
use sim::{SimulateTrafficArgs, TrafficSim};
mod x;

async fn run_sim(args: SimulateTrafficCli) -> eyre::Result<()> {
    let sim = SimulateTrafficArgs::try_from(args)?;
    let sim = TrafficSim::new(sim).await?;
    sim.run().await
}

async fn run(cli: Cli) {
    tracing_subscriber::fmt::init();
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");
    match cli.command {
        Commands::Recipient(args) => {
            let converted =
                dymension_kaspa::ops::addr::kaspa_address_to_hex_recipient(&args.address);
            println!("{converted}",);
        }
        Commands::Deposit(args) => {
            let res = x::deposit::do_deposit(args.to_deposit_args()).await;
            if let Err(e) = res {
                eprintln!("Error: {e}");
            }
        }
        Commands::Escrow(args) => {
            let pub_keys = args
                .pub_keys
                .split(",")
                .map(|s| s.trim())
                .collect::<Vec<_>>();
            let e = x::escrow::get_escrow_address(pub_keys, args.required_signatures, &args.env);
            println!("Escrow address: {e}");
        }
        Commands::Validator { action } => match action {
            ValidatorAction::Create { backend } => match backend {
                ValidatorBackend::Local(args) => {
                    if let Err(e) = x::validator::handle_local_backend(args) {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }
                }
                ValidatorBackend::Aws(args) => {
                    if let Err(e) = x::validator::handle_aws_backend(args).await {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }
                }
            },
        },
        Commands::Relayer => {
            let signer = x::relayer::create_relayer();
            println!("Relayer address: {}", signer.address);
            println!("Relayer private key: {}", signer.private_key);
        }
        Commands::Sim(args) => {
            if let Err(e) = run_sim(args).await {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Roundtrip(args) => {
            if let Err(e) = sim::roundtrip::do_roundtrip(args).await {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        Commands::DecodePayload(args) => {
            if let Err(e) = x::decode_payload::decode_payload(&args.payload) {
                eprintln!("decode payload: {e}");
                std::process::exit(1);
            }
        }
        Commands::ComputeDepositId(args) => {
            if let Err(e) = x::compute_deposit_id::compute_deposit_id(
                &args.payload,
                &args.tx_id,
                args.utxo_index,
            ) {
                eprintln!("compute deposit id: {e}");
                std::process::exit(1);
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    run(cli).await;
}
