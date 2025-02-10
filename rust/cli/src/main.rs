use std::str::FromStr;
use std::sync::Arc;

use clap::Parser;
use ethers::providers::{Http, Provider};
use ethers::types::H256;
use ethers::{abi::Address, contract::abigen, middleware::Middleware};
use url::Url;

use crate::args::{Args, Op};

mod args;

abigen!(Mailbox, "./Mailbox.json");

#[tokio::main]
async fn main() {
    let args = Args::parse().command;

    match args {
        Op::Check {
            origin_rpc,
            mailbox_addr,
        } => {
            let (origin_rc, _) =
                get_providers(origin_rpc, Url::from_str("http://0.0.0.0").unwrap()).await;

            let mailbox_addr = mailbox_addr
                .parse::<Address>()
                .expect("Mailbox address to be valid");

            let mailbox = Mailbox::new(mailbox_addr, origin_rc.clone());
            println!("Fetching logs\n");
            let logs = check_logs(mailbox).await;

            for log in logs {
                println!("{}", log);
            }
        }
        Op::Send {
            mailbox_addr,
            origin_rpc,
            destination_rpc,
            recipient,
            sender,
        } => {
            // address of the mailbox contract
            let mailbox_addr = mailbox_addr
                .parse::<Address>()
                .expect("Mailbox address to be valid");

            println!("Mailbox address: {}\n", mailbox_addr);

            let (origin_rc, destination_rc) = get_providers(origin_rpc, destination_rpc).await;

            // Construct instance of contract, send from the origin_rc
            // mailbox address is same for both local anvil chains
            let mailbox_contract_origin = Mailbox::new(mailbox_addr, origin_rc.clone());

            // get destination chain_id
            let destination_chain_id = destination_rc
                .get_chainid()
                .await
                .expect("The chain id should be retrivable")
                .as_u32();

            send_hyperlane_msg(
                recipient,
                sender,
                mailbox_contract_origin,
                destination_chain_id,
            )
            .await;
        }
    }
}

// send hyperlane message and print result
async fn send_hyperlane_msg<T: Middleware>(
    recipient: String,
    sender: String,
    mailbox_contract_origin: Mailbox<T>,
    destination_chain_id: u32,
) {
    let body = b"Hello this is Daksh from Hyperlane!!!";
    let recipient = recipient
        .parse::<H256>()
        .expect("Mailbox recipient to be valid");

    let sender = sender
        .parse::<Address>()
        .expect("Expected Sender address  to be valid");

    let recipient_bytes = *recipient.as_fixed_bytes();

    let mut resp =
        mailbox_contract_origin.dispatch_0(destination_chain_id, recipient_bytes, body.into());

    resp.tx.set_from(sender);

    let call = resp.send().await.expect("Problem in sending transaction");

    println!("Call result: {:?}!", call.await);
}

// get json network logs with `DispatchFilter` as the filter from block 0
async fn check_logs<T: Middleware>(contract: Mailbox<T>) -> Vec<String> {
    let vec = contract
        .event::<DispatchFilter>()
        .from_block(0)
        .query()
        .await
        .expect("Fetching logs should succeed");

    let mut structured_log = Vec::new();

    for filter in vec {
        let message_str = String::from_utf8_lossy(filter.message.iter().as_slice());
        let address = H256::from_slice(&filter.recipient);

        let log = format!(
            "\x1b[93m[HYPERLANE-MSG]\x1b[0m recipient_address: {:?}, Found sender_address: {}, destination: {}, message: {}\n",
            address, filter.sender, filter.destination, message_str
        );

        structured_log.push(log);
    }

    structured_log
}

// get providers given origin and destination url
async fn get_providers(
    origin: Url,
    destination: Url,
) -> (Arc<Provider<Http>>, Arc<Provider<Http>>) {
    // Connect both the origin and destination chain
    let provider_origin = Provider::<Http>::try_from(origin.as_str()).unwrap();
    let provider_destination = Provider::<Http>::try_from(destination.as_str()).unwrap();

    (Arc::new(provider_origin), Arc::new(provider_destination))
}
