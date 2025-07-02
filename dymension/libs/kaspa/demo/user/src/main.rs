use clap::ArgMatches;
mod x;
use x::args::cli;

async fn run(matches: ArgMatches) {
    let is_verbose = matches.get_flag("verbose");
    if is_verbose {
        println!("Verbose mode is enabled");
    }

    match matches.subcommand() {
        Some(("recipient", sub_matches)) => {
            if sub_matches.get_flag("verbose") {}
            let address = sub_matches
                .get_one::<String>("ADDRESS")
                .expect("required argument");
            let converted = x::addr::hl_recipient(address);
            println!("The recipient address is: {}", converted);
        }
        Some(("validator", sub_matches)) => {
            if sub_matches.get_flag("verbose") {}
            let v = x::escrow::create_one_new_validator();
            println!("Validator infos: {}", v.to_string());
        }
        Some(("deposit", sub_matches)) => {
            if sub_matches.get_flag("verbose") {}
            let args = x::deposit::DepositArgs::parse();
            let res = x::deposit::do_deposit(args).await;
            if let Err(e) = res {
                eprintln!("Error: {}", e);
            }
        }
        _ => {
            unreachable!();
        }
    }
}

#[tokio::main]
async fn main() {
    let matches = cli().get_matches();
    run(matches).await;
}
