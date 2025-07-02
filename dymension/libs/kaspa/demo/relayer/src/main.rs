#![allow(unused)] // TODO: remove

use kaspa_addresses::Address;
mod x;
use hardcode::e2e::*;
use x::args::Args;
use x::deposit::{demo, DemoArgs};

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let mut demo_args = DemoArgs::default();
    demo_args.payload = args.payload;
    demo_args.only_deposit = args.only_deposit;
    demo_args.wallet_secret = args.wallet_secret.unwrap_or("".to_string());
    let amt = args.amount.unwrap_or(DEPOSIT_AMOUNT);
    let escrow_address = if let Some(e) = args.escrow_address {
        Address::try_from(e).unwrap()
    } else {
        Address::try_from(ESCROW_ADDRESS).unwrap()
    };

    demo_args.amt = amt;
    demo_args.escrow_address = escrow_address;

    if let Err(e) = demo(demo_args).await {
        eprintln!("Error: {}", e);
    }
}
