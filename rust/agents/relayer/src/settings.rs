//! Configuration

use regex::Regex;
use serde::Deserialize;

use abacus_base::decl_settings;
use abacus_core::Address;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct RawWhitelist {
    source_address: String,
    source_domain: String,
    destination_address: String,
    destination_domain: String,
}

#[derive(Debug)]
pub struct CompiledWhitelist {
    source_address: Regex,
    source_domain: Regex,
    destination_address: Regex,
    destination_domain: Regex,
}

impl TryFrom<RawWhitelist> for CompiledWhitelist {
    type Error = eyre::Report;

    fn try_from(wl: RawWhitelist) -> eyre::Result<Self> {
        Ok(Self {
            source_address: Regex::new(&make_full_match_regex(wl.source_address))?,
            source_domain: Regex::new(&make_full_match_regex(wl.source_domain))?,
            destination_address: Regex::new(&make_full_match_regex(wl.destination_address))?,
            destination_domain: Regex::new(&make_full_match_regex(wl.destination_domain))?,
        })
    }
}

impl CompiledWhitelist {
    pub fn matches(
        src_addr: &Address,
        src_domain: &str,
        dst_addr: &Address,
        dst_domain: &str,
    ) -> bool {
        todo!()
    }
}

decl_settings!(Relayer {
    /// The polling interval to check for new signed checkpoints in seconds
    signedcheckpointpollinginterval: String,
    /// The maximum number of times a processor will try to process a message
    maxprocessingretries: String,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: abacus_base::MultisigCheckpointSyncerConf,
    /// Whitelist defining which messages should be published. If no wishlist is provided ALL
    /// messages will be published.
    ///
    /// All values should be regex strings and will be used as full-match checks, so using simply
    /// `"test"` will match only the exact string `"test"` and not any string containing it such as
    /// `"testing things..."`.
    ///
    /// Addresses will always be provided as lowercase hex strings starting with `0x`.
    whitelist: Option<RawWhitelist>,
});

/// Make any given regex we get into a "full-match" check of `^<user_regex>$`, but also don't break
/// any regex that was already including the start or end checks.
fn make_full_match_regex(mut raw: String) -> String {
    if !raw.starts_with('^') {
        raw.insert(0, '^')
    }
    if !raw.ends_with('$') {
        raw.push('$');
    }
    raw
}
