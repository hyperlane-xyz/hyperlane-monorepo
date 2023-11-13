use anyhow::{bail, Result};
use ethers::{
    abi::AbiDecode,
    types::{Address,  U256, Filter, H160, H256}, providers::Middleware,
};

use crate::{utils::{PROVIDER, MAILBOX}, Dispatch};



#[derive(Debug, Default)]
pub struct Query;

impl Query {
    /// Queries for events within a specified block range and optional filters
    /// 
    /// # Arguments
    /// * `from_block` - The starting block number for the query
    /// * `to_block` - The ending block number for the query (optional)
    /// * `sender_address` - The sender's address to filter (optional)
    /// * `receiver_id` - The receiver's ID to filter (optional)
    /// * `receiver_address` - The receiver's address to filter (optional)
    pub async fn events_in_range(
        from_block: u64,
        to_block: Option<u64>,
        sender_address: Option<String>,
        receiver_id: Option<u32>,
        receiver_address: Option<String>,
    ) -> Result<()> {
        // Check if provider and mailbox are initialized
        if let (Some(provider), Some(mailbox)) = (PROVIDER.get(), MAILBOX.get()) {
            // Initialize the filter with base parameters
            let mut filter = Filter::new()
                .address(*mailbox)
                .event("Dispatch(address,uint32,bytes32,bytes)") 
                .from_block(from_block);

            // Apply additional filter parameters if provided
            if let Some(block) = to_block {
                filter = filter.to_block(block);
            }
            if let Some(addr) = sender_address {
                filter = filter.topic1(addr.parse::<Address>()?);
            }
            if let Some(id) = receiver_id {
                filter = filter.topic2(U256::from(id));
            }
            if let Some(addr) = receiver_address {
                let recipient = format!("000000000000000000000000{}", addr);
                filter = filter.topic3(recipient.parse::<H256>()?);
            }

            // Fetch logs based on the constructed filter
            let logs = provider.get_logs(&filter).await?;
            let log_ids = provider.get_logs(&filter).await?;

            // Retrieve the origin chain ID
            let origin: u32 = provider.get_chainid().await?.as_u32();

			println!("Number messages read: {}", logs.len());

            // Process and display each log entry
            logs.iter()
                .zip(log_ids)
                .map(|(record, id)| -> Result<Dispatch> {
                    // Decode each field from the log record
                    let sender = AbiDecode::decode(record.topics[1].as_fixed_bytes())?;
                    let message = AbiDecode::decode(record.data.to_vec().as_slice())?;
                    let receiver = H160::from(record.topics[3]);
                    let destination = AbiDecode::decode(record.topics[2])?;
                    let id = id.topics[1];

                    Ok(Dispatch {
                        id,
                        origin,
                        sender,
                        destination,
                        receiver,
                        message,
                    })
                })
                .for_each(|disp| {
                    if let Ok(res) = disp {
                        let url = format!("https://explorer.hyperlane.xyz/message/{:#?}", res.id);
                        
                        // Print the detailed information of each dispatch
                        println!(
                            "\nLink: {},\nOrigin: {},\nSender: {:#?},\nDestination: {},\nReceiver: {:#?},\nMessage:\n {}\n",
                            url, res.origin, res.sender, res.destination, res.receiver, res.message
                        );
                    }
                });
        } else {
            // Handle the case when provider or mailbox is not initialized
            bail!("Provider or Mailbox is not properly initialized. Ensure they are correctly set up before querying.");
        }

        Ok(())
    }
}
