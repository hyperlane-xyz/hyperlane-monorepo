use hex::{FromHex, ToHex};
use kaspa_addresses::{Address, Prefix};
use std::env;
use std::str::FromStr;

use hyperlane_core::H256;
use relayer::withdraw_construction::get_recipient_address;

fn main() {
    // forward direction
    let args: Vec<String> = env::args().collect();
    let addr_s = args.get(1).unwrap();
    let addr = Address::try_from(addr_s.as_str()).unwrap();
    println!("{}", addr.to_string());
    let bz = addr.payload.as_slice();
    let bz_hex = hex::encode(bz);
    let s = format!("0x{}", bz_hex);
    println!("{}", s);

    // reverse direction to test

    let unprefixed = s.chars().skip(2).collect::<String>();
    let unhexed = hex::decode(unprefixed).unwrap();
    let decoded = H256::from_slice(&unhexed);

    let prefix = Prefix::Testnet;
    let recipient_addr = get_recipient_address(decoded, prefix);
    if recipient_addr.to_string() != addr_s.as_str() {
        println!("{}", "something wrong");
    }
}
