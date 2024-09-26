use std::path::Path;

use crate::config::Config;

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
#[allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue
pub fn termination_invariants_met(
    _config: &Config,
    _starting_relayer_balance: f64,
    _solana_cli_tools_path: Option<&Path>,
    _solana_config_path: Option<&Path>,
) -> eyre::Result<bool> {
    Ok(false)
}
