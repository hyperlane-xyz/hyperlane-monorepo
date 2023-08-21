use eyre::{eyre, Context};
use hyperlane_base::{decl_settings, settings::Settings};
use hyperlane_core::{config::*, HyperlaneDomain};
use itertools::Itertools;

decl_settings!(Scraper,
    Parsed {
        db: String,
        chains_to_scrape: Vec<HyperlaneDomain>,
    },
    Raw {
        /// Database connection string
        db: Option<String>,
        /// Comma separated list of chains to scrape
        chainstoscrape: Option<String>,
    }
);

impl FromRawConf<RawScraperSettings> for ScraperSettings {
    fn from_config_filtered(
        raw: RawScraperSettings,
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
