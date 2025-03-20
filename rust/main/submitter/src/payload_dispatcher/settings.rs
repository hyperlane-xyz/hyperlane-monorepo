// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::path::PathBuf;

use hyperlane_base::settings::Settings;
use hyperlane_core::HyperlaneDomain;

/// Settings for `PayloadDispatcher`
#[derive(Debug)]
pub struct PayloadDispatcherSettings {
    // settings needed for the adapter
    base: Settings,
    /// Follow how `Settings` is parsed from `RawAgentConf` to parse custom fields
    /// https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/ff0d4af74ecc586ef0c036e37fa4cf9c2ba5050e/rust/main/hyperlane-base/tests/chain_config.rs#L82
    // raw_json_settings: RawAgentConf,
    domain: HyperlaneDomain,

    db_path: PathBuf,
}
