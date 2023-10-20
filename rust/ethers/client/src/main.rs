//! Test client for Hyperlane Ethers Mailbox contract.

use clap::{Parser, Subcommand};
use ethers::{
    middleware::SignerMiddleware,
    prelude::*,
    providers::{Http, Provider},
    utils::hex,
};
use eyre::Result;
use std::sync::Arc;

const GOERLI_CHAIN_ID: u32 = 5;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    // TODO: Read configurations from a config file
    // /// Sets a custom config file
    // #[arg(short, long, value_name = "FILE")]
    // config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Send a message from an origin chain to a recipient address that is located in a destination chain
    Send {
        /// Origin chain id, default is goerli chain id
        #[arg(long, short, default_value_t = GOERLI_CHAIN_ID)]
        origin: u32,
        /// Mailbox smart contract address
        #[arg(long, short)]
        mailbox: Address,
        /// Chain url
        #[arg(long, short)]
        url: String,
        /// Destination chain id, default is goerli chain id
        #[arg(long, short, default_value_t = GOERLI_CHAIN_ID)]
        destination: u32,
        /// Sender private key, do not include '0x' at the start of the private key
        #[arg(long, short)]
        sender_private_key: String,
        /// Recipient address
        #[arg(long, short)]
        recipient: Address,
        /// Message to be sent
        #[arg(long, short = 'M', default_value = "Hello, World!")]
        message: String,
    },
    /// Search for messages that has been sent from an origin chain
    Search {
        /// Mailbox smart contract address
        #[arg(long, short)]
        mailbox: Address,
        /// Chain url
        #[arg(long, short)]
        url: String,
        /// From block number
        #[arg(long, short, default_value = "0")]
        from_block: u32,
        /// To block number
        #[arg(long, short, default_value = "*")]
        to_block: String,
        /// Recipient addresses
        #[arg(long, short, default_value = "*")]
        sender: String,
        /// Destination chain id
        #[arg(long, short, default_value = "*")]
        destination: String,
        /// Recipient addresses
        #[arg(long, short, default_value = "*")]
        recipient: String,
    },
}

type Client = SignerMiddleware<Provider<Http>, Wallet<k256::ecdsa::SigningKey>>;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    pretty_env_logger::init();

    let cli = Cli::parse();
    match &cli.cmd {
        Some(Commands::Send {
            origin,
            mailbox,
            url,
            destination,
            sender_private_key,
            recipient,
            message,
        }) => {
            // Validate argument values
            if mailbox.is_zero() {
                println!("Mailbox address is not specified");
            } else if url.is_empty() {
                println!("Url is not specified");
            } else if recipient.is_zero() {
                println!("Recipient address is not specified");
            } else if message.is_empty() {
                println!("Nothing to be sent");
            } else {
                println!("Sending message \"{message}\" through url {url} and mailbox {mailbox} from {origin} to {destination} address {recipient}");

                let message: Bytes = message.as_bytes().to_owned().into();

                let provider = Provider::<Http>::try_from(url)?;

                let origin_chain_id = provider.get_chainid().await?.as_u32();

                // Use the input private key to create a wallet
                let wallet: LocalWallet = sender_private_key
                    .parse::<LocalWallet>()?
                    .with_chain_id(origin_chain_id);

                // Wrap the provider and wallet together to create a signer client
                let client: SignerMiddleware<Provider<Http>, Wallet<k256::ecdsa::SigningKey>> =
                    SignerMiddleware::new(provider.clone(), wallet.clone());

                // Convert recipient from H160 to H256
                let recipient = h160_to_h256(*recipient);

                send(&client, &mailbox, *destination, recipient, message).await?;
            }
        }
        Some(Commands::Search {
            mailbox,
            url,
            from_block,
            to_block,
            sender,
            destination,
            recipient,
        }) => {
            // Validate argument values
            if mailbox.is_zero() {
                println!("Mailbox address is not specified");
            } else if url.is_empty() {
                println!("Url is not specified");
            } else {
                println!("Querying messages sent from {mailbox} through url {url} with sender {sender}, destination {destination}, and recipient {recipient}");

                let provider = Provider::<Http>::try_from(url)?;

                // Wrap the provider and wallet together to create a signer client
                let client = Arc::new(provider);

                search(
                    &client,
                    mailbox,
                    *from_block,
                    to_block.to_string(),
                    sender.to_string(),
                    destination.clone(),
                    recipient.to_string(),
                )
                .await?;
            }
        }
        None => {
            println!("Subcommand [send|search] is not specified.");
        }
    }

    Ok(())
}

abigen!(
    Mailbox,
    "../../chains/hyperlane-ethereum/abis/Mailbox.abi.json",
    event_derives(serde::Deserialize, serde::Serialize)
);

const DISPATCH_EVENT_SIGNATURE: &str = "Dispatch(address,uint32,bytes32,bytes)";

async fn send(
    client: &Client,
    mailbox_contract_addr: &H160,
    destination_domains: u32,
    recipient_address: H256,
    message: Bytes,
) -> Result<(), Box<dyn std::error::Error>> {
    // Create a contract instance
    let contract = Mailbox::new(mailbox_contract_addr.clone(), Arc::new(client.clone()));

    // Call dispatch function to send the message
    let tx = contract
        .dispatch(
            destination_domains,
            recipient_address.to_fixed_bytes(),
            message,
        )
        .send()
        .await?
        .await?;

    //  Print the transaction receipt
    println!("Transaction Receipt: {}", serde_json::to_string(&tx)?);

    Ok(())
}

async fn search(
    client: &Arc<ethers::providers::Provider<Http>>,
    mailbox: &H160,
    from_block: u32,
    to_block: String,
    sender_addresses: String,
    destination_domains: String,
    receiver_address: String,
) -> Result<()> {
    // Create a filter
    let mut filter = Filter::new()
        .address(Address::from(*mailbox))
        .event(DISPATCH_EVENT_SIGNATURE)
        .from_block(from_block);

    // Add filter condition: to block number
    if to_block != "*" {
        let to_block = to_block.parse::<u32>()?;
        filter = filter.to_block(to_block);
    }

    // Add filter condition: sender address
    if sender_addresses != "*" {
        let mut senders: Vec<Address> = vec![];
        for sender in sender_addresses.split(',') {
            let sender = sender.parse::<Address>()?;
            senders.push(sender);
        }
        filter = filter.topic1(senders);
    }

    // Add filter condition: destination domain
    if destination_domains != "*" {
        let mut destinations: Vec<H256> = vec![];
        for destination_domain in destination_domains.split(',') {
            let destination = destination_domain.parse::<u32>()?;
            destinations.push(u32_to_h256(destination));
        }
        filter = filter.topic2(destinations);
    }

    // Add filter condition: recipient address
    if receiver_address != "*" {
        let mut receivers: Vec<H256> = vec![];
        for receiver in receiver_address.split(',') {
            let bytes = hex::decode(receiver.trim_start_matches("0x"))?;
            receivers.push(h160_to_h256(H160::from_slice(&bytes)));
        }
        filter = filter.topic3(receivers);
    }

    // Get the logs
    let dispatched_logs = client.get_logs(&filter).await?;

    // Print the logs
    let mut n = 1;
    for log in dispatched_logs.iter() {
        let sender = Address::from(log.topics[1]).to_string();
        let destination = U256::from_big_endian(&log.topics[2].as_bytes()[29..32]);
        let recipient = hex::encode(log.topics[3].as_bytes());
        // TODO: decode the message body and print it out as well
        println!("{n}: sender {sender} destination {destination} recipient {recipient}");
        n += 1;
    }

    Ok(())
}

fn h160_to_h256(value: H160) -> H256 {
    let mut bytes = [0u8; 32];

    // copy H160 into the 32 byte array's last 20 bytes
    bytes[12..32].copy_from_slice(&value.to_fixed_bytes());

    H256::from_slice(&bytes)
}

fn u32_to_h256(value: u32) -> H256 {
    let mut bytes = [0u8; 32];

    // copy u32 into the 32 byte array's last 4 bytes
    bytes[28..32].copy_from_slice(&value.to_be_bytes());

    H256::from_slice(&bytes)
}
