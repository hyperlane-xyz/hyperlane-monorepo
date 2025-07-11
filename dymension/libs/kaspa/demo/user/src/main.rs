use clap::Parser;
use x::args::{Cli, Commands};

mod x;

async fn run(cli: Cli) {
    match cli.command {
        Commands::Recipient(args) => {
            let converted = x::addr::hl_recipient(&args.address);
            println!("{}", converted);
        }
        Commands::Deposit(args) => {
            let res = x::deposit::do_deposit(args.to_deposit_args()).await;
            if let Err(e) = res {
                eprintln!("Error: {}", e);
            }
        }
        Commands::Escrow(args) => {
            let pub_keys = args
                .pub_keys
                .split(",")
                .map(|s| s.trim())
                .collect::<Vec<_>>();
            let e = x::escrow::get_escrow_address(pub_keys);
            println!("Escrow address: {}", e);
        }
        Commands::Validator(args) => {
            let mut infos = vec![];
            for _ in 0..args.n {
                let (v, _) = x::escrow::create_validator();
                infos.push(v);
            }
            // sort required by Hyperlane Cosmos ISM creation
            infos.sort_by(|a, b| a.validator_ism_addr.cmp(&b.validator_ism_addr));
            println!("{}", serde_json::to_string_pretty(&infos).unwrap());
        }
        Commands::ValidatorAndEscrow => {
            let v = x::escrow::create_validator_with_escrow();
            println!("Validator infos: {}", v.to_string());
        }
        Commands::Relayer => {
            let signer = x::relayer::create_relayer();
            println!("Relayer address: {}", signer.address);
            println!("Relayer private key: {}", signer.private_key);
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    run(cli).await;
}
