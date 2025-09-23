use hyperlane_sovereign::types::TxEvent;

use super::types::{get_or_create_client, ChainConfig, ChainRegistry};

fn count_events(events: &[TxEvent]) -> eyre::Result<(usize, usize)> {
    let mut process_count = 0;
    let mut dispatch_count = 0;

    for event in events {
        match &event.key {
            "Mailbox/Process" => process_count += 1,
            "Mailbox/Dispatch" => dispatch_count += 1,
            _ => {}
        }
    }

    Ok((process_count, dispatch_count))
}

pub async fn check_chain_invariants(
    chain: &ChainConfig,
    expected_count: usize,
) -> eyre::Result<bool> {
    let client = get_or_create_client(chain).await;
    let page_size = 100;
    let mut page_offset = 0;
    let mut process_count = 0;
    let mut dispatch_count = 0;

    loop {
        let endpoint = format!(
            "/ledger/events?page=next&page[size]={}&page[cursor]={}",
            page_size, page_offset
        );
        let events = client.http_get::<Vec<TxEvent>>(&endpoint).await?;

        if events.is_empty() {
            break;
        }

        let (processed, dispatched) = count_events(&events);

        process_count += processed;
        dispatch_count += dispatched;

        if process_count == expected_count && dispatch_count == expected_count {
            return Ok(true);
        }

        page_offset += page_size;
    }

    Ok(false)
}

pub async fn termination_invariants_met(
    registry: &ChainRegistry,
    expected_count: usize,
) -> eyre::Result<bool> {
    for chain in registry.chains.values() {
        if !check_chain_invariants(chain, expected_count).await? {
            return Ok(false);
        }
    }

    Ok(true)
}
