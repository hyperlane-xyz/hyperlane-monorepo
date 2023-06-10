use std::sync::Arc;

use crate::{contracts::Mailbox, core, param::QueryParams, query::MailboxLogs};
use color_eyre::{eyre::Context, Result};
use ethers::providers::Middleware;
use hyperlane_core::H160;

/// Query for messages sent to a Hyperlane mailbox contract matching a provided filter.
///
/// Filters are implemented as [Ethereum event filters](https://docs.ethers.io/v5/api/providers/provider/#Provider-getLogs).
#[allow(unused_variables)]
pub async fn query<M: Middleware + 'static>(
    client: Arc<M>,
    chain_id: u32,
    mailbox_address: H160,
    params: &QueryParams,
) -> Result<()> {
    if params.debug {
        println!("{params:#?}");
        return Ok(());
    }
    let mailbox = Arc::new(Mailbox::new(mailbox_address, Arc::clone(&client)));

    let block_number = client
        .get_block_number()
        .await
        .context("Failed to retrieve block number")?
        .as_u64();
    // println!("  Block: {block_number}");

    let end_block = std::cmp::min(
        block_number,
        resolve_negative_block_number(block_number, params.end_block),
    );
    let start_block = std::cmp::min(
        end_block,
        resolve_negative_block_number(block_number, params.start_block),
    );

    let logs = MailboxLogs::new(
        chain_id,
        mailbox.clone(),
        params.criteria.clone(),
        start_block,
        end_block,
    )
    .await?;

    for log in &logs {
        println!(
            "{} in block {} to {} domain:",
            log.event_type(),
            core::option_into_display_string(&log.block_number()),
            log.destination_domain()
        );
        println!(
            "  Tx hash  : {}",
            core::option_into_debug_string(&log.transaction_hash())
        );
        println!("  Sender   : {:?}", log.sender());
        println!("  Recipient: {:?}", log.recipient());
    }

    Ok(())
}

fn resolve_negative_block_number(current_blocknumber: u64, relative_blocknumber: i32) -> u64 {
    if relative_blocknumber < 0 {
        let current_blocknumber = current_blocknumber as i64;
        std::cmp::max(0, current_blocknumber + 1 + relative_blocknumber as i64) as u64
    } else {
        relative_blocknumber as u64
    }
}

// Abandoned, for now, simpler approach of having a less restrictive filter on the chain
// and then further filtering the results in the client.
//
// This will not work well when wildcards are used in different positions for different filters.
//
// // We don't want to pull all logs from the mailbox contract, so we need to build a filter.
// // This filter might not be as restrictive as the MatchingList filter, but it will be a superset.
// // Build this filter by combining all .... but if there is a wildcard, we can't do that.
// let mut origins: HashSet<u32> = HashSet::new();
// let mut destinations: HashSet<u32> = HashSet::new();
// let mut senders: HashSet<H256> = HashSet::new();
// let mut recipients: HashSet<H256> = HashSet::new();
// if let Some(list) = &params.criteria.0 {
//     for item in list {
//         include_filter_items_in_set(&item.origin_domain, &mut origins);
//         include_filter_items_in_set(&item.sender_address, &mut senders);
//         include_filter_items_in_set(&item.destination_domain, &mut destinations);
//         include_filter_items_in_set(&item.recipient_address, &mut recipients);
//     }
// }
//
// fn include_filter_items_in_set<T: Copy + PartialEq + Eq + Hash>(item: &Filter<T>, set: &mut HashSet<T>) {
//     if let Filter::Enumerated(vec) = item {
//         for item in vec {
//             set.insert(*item);
//         }
//     }
// }
