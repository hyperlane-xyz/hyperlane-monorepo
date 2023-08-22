//! Scraper configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{deprecated_parser::DeprecatedRawSettings, Settings},
};
use hyperlane_core::{config::*, HyperlaneDomain};
use itertools::Itertools;
use serde::Deserialize;

/// Settings for `Scraper`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct ScraperSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    base: Settings,

    pub db: String,
    pub chains_to_scrape: Vec<HyperlaneDomain>,
}

/// Raw settings for `Scraper`
#[derive(Debug, Deserialize, AsMut)]
#[serde(rename_all = "camelCase")]
pub struct DeprecatedRawScraperSettings {
    #[serde(flatten, default)]
    #[as_mut]
    base: DeprecatedRawSettings,
    /// Database connection string
    db: Option<String>,
    /// Comma separated list of chains to scrape
    chainstoscrape: Option<String>,
}

impl_loadable_from_settings!(Scraper, DeprecatedRawScraperSettings -> ScraperSettings);

impl FromRawConf<DeprecatedRawScraperSettings> for ScraperSettings {
    fn from_config_filtered(
        raw: DeprecatedRawScraperSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let db = raw
            .db
            .ok_or_else(|| eyre!("Missing `db` connection string"))
            .take_err(&mut err, || cwp + "db");

        let Some(chains_to_scrape) = raw
            .chainstoscrape
            .ok_or_else(|| eyre!("Missing `chainstoscrape` list"))
            .take_err(&mut err, || cwp + "chainstoscrape")
            .map(|s| s.split(',').map(str::to_ascii_lowercase).collect::<Vec<_>>())
            else { return Err(err) };

        let base = raw
            .base
            .parse_config_with_filter::<Settings>(
                cwp,
                Some(&chains_to_scrape.iter().map(String::as_str).collect()),
            )
            .take_config_err(&mut err);

        let chains_to_scrape = base
            .as_ref()
            .map(|base| {
                chains_to_scrape
                    .iter()
                    .filter_map(|chain| {
                        base.lookup_domain(chain)
                            .context("Missing configuration for a chain in `chainstoscrape`")
                            .take_err(&mut err, || cwp + "chains" + chain)
                    })
                    .collect_vec()
            })
            .unwrap_or_default();

        err.into_result(Self {
            base: base.unwrap(),
            db: db.unwrap(),
            chains_to_scrape,
        })
    }
}
