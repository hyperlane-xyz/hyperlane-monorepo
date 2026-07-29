//! Scraper configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{
    collections::{HashMap, HashSet},
    default::Default,
    ops::Add,
    str::FromStr,
};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::Context;
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        parser::{RawAgentConf, ValueParser},
        Settings,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain, H160};
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
    /// Per-domain CCR contract → underlying ERC20 token mapping.
    /// Domain ID → { router_address → token_address }.
    /// Only domains present here will spawn a CCR swap indexer.
    pub ccr_routers: HashMap<u32, HashMap<H160, H160>>,
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
                        .into_config_result(|| cwp.add("chains_to_scrape"))
                        .take_config_err(&mut err)
                })
                .collect()
        } else {
            Default::default()
        };

        // Parse optional ccrRouters: { "domainId": { "routerAddr": "tokenAddr" } }
        let raw_ccr_routers = p
            .chain(&mut err)
            .get_opt_key("ccrRouters")
            .parse_value::<HashMap<String, HashMap<String, String>>>("parsing ccrRouters")
            .end()
            .unwrap_or_default();

        let mut ccr_routers: HashMap<u32, HashMap<H160, H160>> = HashMap::new();
        for (domain_str, router_map) in raw_ccr_routers {
            let Some(domain_id) = domain_str
                .parse::<u32>()
                .with_context(|| format!("Invalid domain ID '{domain_str}' in ccrRouters"))
                .into_config_result(|| cwp.add("ccrRouters"))
                .take_config_err(&mut err)
            else {
                continue;
            };
            let mut domain_routers = HashMap::new();
            for (router, token) in router_map {
                let Some(r) = H160::from_str(&router)
                    .with_context(|| {
                        format!("Invalid router address '{router}' for domain '{domain_str}' in ccrRouters")
                    })
                    .into_config_result(|| cwp.add("ccrRouters"))
                    .take_config_err(&mut err)
                else {
                    continue;
                };
                let Some(t) = H160::from_str(&token)
                    .with_context(|| {
                        format!("Invalid token address '{token}' for router '{router}' in domain '{domain_str}' ccrRouters")
                    })
                    .into_config_result(|| cwp.add("ccrRouters"))
                    .take_config_err(&mut err)
                else {
                    continue;
                };
                domain_routers.insert(r, t);
            }
            ccr_routers.insert(domain_id, domain_routers);
        }

        cfg_unwrap_all!(&p.cwp, err: [base, db]);

        err.into_result(Self {
            base,
            db,
            chains_to_scrape,
            ccr_routers,
        })
    }
}
