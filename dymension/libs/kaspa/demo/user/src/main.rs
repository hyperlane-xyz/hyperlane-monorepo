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
        Commands::Validator => {
            let (v, _) = x::escrow::create_validator();
            println!("Validator infos: {}", v.to_string());
        }
        Commands::ValidatorAndEscrow => {
            let v = x::escrow::create_validator_with_escrow();
            println!("Validator infos: {}", v.to_string());
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    run(cli).await;
}
