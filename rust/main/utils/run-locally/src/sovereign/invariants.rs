use crate::config::Config;
use crate::invariants::{
    relayer_termination_invariants_met, scraper_termination_invariants_met,
    RelayerTerminationInvariantParams, ScraperTerminationInvariantParams,
};
use crate::server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count};

pub fn termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
    expected_count: usize,
) -> eyre::Result<bool> {
    let messages_expected = expected_count as u32;

    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;
    let relayer_params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected: messages_expected,
        total_messages_dispatched: messages_expected,
        failed_message_count: 0,
        submitter_queue_length_expected: 0,
        non_matching_igp_message_count: 0,
        double_insertion_message_count: 0,
        skip_tx_id_indexing: true,
        submitter_type: Default::default(),
    };

    if !relayer_termination_invariants_met(relayer_params)? {
        return Ok(false);
    }

    let scraper_params = ScraperTerminationInvariantParams {
        gas_payment_events_count,
        total_messages_dispatched: messages_expected,
        delivered_messages_scraped_expected: messages_expected,
    };

    if !scraper_termination_invariants_met(scraper_params)? {
        return Ok(false);
    }

    Ok(true)
}
