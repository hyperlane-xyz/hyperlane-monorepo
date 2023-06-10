use std::sync::Arc;

use crate::contracts::Mailbox;
use crate::core;
use color_eyre::Result;
use ethers::{providers::Middleware, types::Bytes};
use hyperlane_core::{H160, H256};

/// Dispatch a message to the Hyperlane mailbox contract.
pub async fn dispatch<M: Middleware + 'static>(
    client: Arc<M>,
    mailbox_address: H160,
    dest_id: u32,
    recipient_address: H160,
    message_body: Vec<u8>,
    verbose: bool,
) -> Result<()> {
    let mailbox = Mailbox::new(mailbox_address, Arc::clone(&client));

    let recipient_address: H256 = recipient_address.into();
    let tx_receipt = mailbox
        .dispatch(dest_id, recipient_address.into(), Bytes::from(message_body))
        .send()
        .await?
        .confirmations(1)
        .await?;

    if verbose {
        println!("Transaction receipt: {:#?}", tx_receipt);
    };

    match tx_receipt {
        Some(receipt) => {
            println!(
                "Transaction completed in block {}, hash: {:?}",
                core::option_into_display_string(&receipt.block_number),
                receipt.transaction_hash
            );

            // TODO: ID lookup path coincidentally works for now, but this is not a reliable way to get the message ID.
            // Should be based on iterating through logs and matching topics[0] to event signature.
            let id = receipt.logs[1].topics[1];
            println!("  Message ID: {:?}", id);
        }
        None => println!("Transaction status unknown"),
    }

    Ok(())
}
