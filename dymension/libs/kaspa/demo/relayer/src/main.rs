#![allow(unused)] // TODO: remove

use kaspa_addresses::Address;
mod x;
use hardcode::e2e::*;
use x::args::Args;
use x::deposit::{demo, DemoArgs};

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let amt = args.amount.unwrap_or(DEPOSIT_AMOUNT);

    let escrow_address = if let Some(e) = args.escrow_address {
        Address::try_from(e).unwrap()
    } else {
        Address::try_from(ESCROW_ADDRESS).unwrap()
    };

    let demo_args = DemoArgs {
        amt,
        escrow_address,
        payload: args.payload,
        only_deposit: args.only_deposit,
        wallet_secret: args.wallet_secret.unwrap_or("".to_string()),
        wprc_url: args.rpc_server,
    };

    if let Err(e) = demo(demo_args).await {
        eprintln!("Error: {e}");
    }
}
