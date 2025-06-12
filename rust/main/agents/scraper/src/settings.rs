//! Scraper configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, default::Default};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::Context;
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        parser::{RawAgentConf, ValueParser},
        Settings,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain};
use serde::Deserialize;
use serde_json::Value;

/// Settings for `Scraper`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct ScraperSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    pub base: Settings,

    pub db: String,
    pub chains_to_scrape: Vec<HyperlaneDomain>,
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawScraperSettings(Value);

impl_loadable_from_settings!(Scraper, RawScraperSettings -> ScraperSettings);

impl FromRawConf<RawScraperSettings> for ScraperSettings {
    fn from_config_filtered(
        raw: RawScraperSettings,
        cwp: &ConfigPath,
        _filter: (),
        agent_name: &str,
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        let chains_names_to_scrape: Option<HashSet<&str>> = p
            .chain(&mut err)
            .get_key("chainsToScrape")
            .parse_string()
            .end()
            .map(|s| s.split(',').collect());

        let base = p
            .parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                chains_names_to_scrape.as_ref(),
                "Parsing base config",
                agent_name.to_string(),
            )
            .take_config_err(&mut err);

        let db = p
            .chain(&mut err)
            .get_key("db")
            .parse_string()
            .end()
            .map(|v| v.to_owned());

        let chains_to_scrape = if let (Some(base), Some(chains)) = (&base, chains_names_to_scrape) {
            chains
                .into_iter()
                .filter_map(|chain| {
                    base.lookup_domain(chain)
                        .context("Missing configuration for a chain in `chainsToScrape`")
                        .into_config_result(|| cwp + "chains_to_scrape")
                        .take_config_err(&mut err)
                })
                .collect()
        } else {
            Default::default()
        };

        cfg_unwrap_all!(&p.cwp, err: [base, db]);

        err.into_result(Self {
            base,
            db,
            chains_to_scrape,
        })
    }
}
