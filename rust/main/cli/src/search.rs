use clap::Args;
use ethers::providers::{Http, Provider};
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, H160, H256};
use hyperlane_ethereum::interfaces::mailbox::Mailbox;
use relayer::settings::matching_list::MatchingList;
use serde_json::json;
use std::str::FromStr;
use std::sync::Arc;

#[derive(Args)]
pub struct SearchArgs {
    #[clap(short, long)]
    origin_domain: u32,
    #[clap(short = 'q', long, default_value = "*")]
    sender_address: String,
    #[clap(short, long)]
    mailbox: String,
    #[clap(short, long)]
    rpc: String,
    #[clap(short = 'd', long, default_value = "*")]
    destination_domain: String,
    #[clap(short = 'a', long, default_value = "*")]
    destination_address: String,
    #[clap(short, long)]
    starting_block: u64,
}

impl SearchArgs {
    pub async fn search(self) -> Result<()> {
        // Setup provider and mailbox
        let provider = Arc::new(Provider::<Http>::try_from(&self.rpc)?);
        let mailbox = Mailbox::new(H160::from_str(&self.mailbox)?, provider);
        // Setup matching list
        let val = json!([
            {
                "messageid": "*",
                "origindomain": self.origin_domain,
                "senderaddress": self.sender_address,
                "destinationdomain": self.destination_domain,
                "recipientaddress": self.destination_address,
            },
        ]);
        println!("Matching list {}", val);
        let matching_list: MatchingList = serde_json::from_value(val)?;
        // Get events
        let events = mailbox
            .dispatch_filter() // TODO: Are we looking for a specific event?
            .from_block(self.starting_block)
            .query()
            .await?;
        // Process events
        let matches: Vec<_> = events.iter().filter(|event| {
            let mut msg = HyperlaneMessage::default();
            msg.recipient = H256::from(event.recipient);
            msg.destination = event.destination;
            msg.sender = H256::from(event.sender);
            msg.body = event.message.to_vec();
            msg.origin = self.origin_domain;
            matching_list.msg_matches(&msg, Default::default())
            })
            .collect();
        println!("Found {} matches\n", matches.len());
        println!("{:?}", matches);
        Ok(())
    }
}
