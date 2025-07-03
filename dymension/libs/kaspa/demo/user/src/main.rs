use clap::Parser;
use x::args::{Cli, Commands};

mod x;

async fn run(cli: Cli) {
    match cli.command {
        Commands::Recipient(args) => {
            let converted = x::addr::hl_recipient(&args.address);
            println!("{}", converted);
        }
        Commands::Validator => {
            let v = x::escrow::create_one_new_validator();
            println!("Validator infos: {}", v.to_string());
        }
        Commands::Deposit(args) => {
            let res = x::deposit::do_deposit(args.to_deposit_args()).await;
            if let Err(e) = res {
                eprintln!("Error: {}", e);
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::try_parse().unwrap();
    run(cli).await;
}
