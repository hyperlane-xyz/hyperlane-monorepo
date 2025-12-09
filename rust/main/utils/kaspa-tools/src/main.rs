use clap::Parser;
use x::args::{Cli, Commands, ValidatorAction, ValidatorBackend};

mod sim;
use sim::{SimulateTrafficArgs, TrafficSim};
mod x;

async fn run(cli: Cli) {
    tracing_subscriber::fmt::init();
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");
    match cli.command {
        Commands::Recipient(args) => {
            let converted = x::addr::hl_recipient(&args.address);
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
        Commands::SimulateTraffic(args) => {
            let sim = SimulateTrafficArgs::try_from(args).unwrap();
            let sim = TrafficSim::new(sim).await.unwrap();
            sim.run().await.unwrap();
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    run(cli).await;
}
