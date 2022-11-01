use eyre::WrapErr;
use std::collections::HashMap;
use std::env;

use abacus_base::load_settings_object;
use abacus_base::{AgentSettings, DomainSettings, NewFromAgentSettings};

/// Scraper settings work a bit differently than other agents because we need to
/// load the information for all of the chains.
///
/// The same basic principals apply as to what files/envs are read from and
/// their order of precedence. You can read more in the `load_settings_object`
/// docs.
///
/// You will need to define `RUN_DOMAINS` which is a comma seperated list of
/// chain names. Then for each domain if a config file is to be read from
/// `BASE_CONFIG_${DOMAIN}` should be specified. The env vars will read with the
/// prefix `HYP_SCRAPER_${DOMAIN}_*` for chain configs, and just `HYP_SCRAPER_*`
/// for any generic application configs.
///
/// `HYP_BASE_*` will still be a default for all chains, so you could define
/// `HYP_BASE_INDEX_CHUNK` and define a default chunk size for all chains.
///
/// You still need the `BASE_CONFIG` if you want to have any application
/// settings loaded via a config file.
#[derive(Debug)]
pub struct ScraperSettings {
    /// settings by domain id for each domain
    pub chains: HashMap<u32, DomainSettings>,
    pub app: AgentSettings,
}

impl AsRef<AgentSettings> for ScraperSettings {
    fn as_ref(&self) -> &AgentSettings {
        &self.app
    }
}

impl NewFromAgentSettings for ScraperSettings {
    type Error = eyre::Report;

    fn new() -> Result<Self, Self::Error> {
        let app = load_settings_object::<_, &str>(
            "scraper",
            env::var("BASE_CONFIG").ok().as_deref(),
            &[],
        )
        .context("Loading application settings")?;
        let uppercase_chain_list = env::var("RUN_DOMAINS")
            .expect("Must specify run domains for scraper")
            .to_ascii_uppercase();
        let chains: Vec<&str> = uppercase_chain_list.split(',').collect();

        let chain_settings = chains
            .iter()
            .map(|chain_name| {
                let config_file_name = env::var(&format!("BASE_CONFIG_{chain_name}"))
                    .expect("Must specify config file for all domains in $RUN_DOMAINS");
                // If we do not ignore these, it will cause a panic. This is because it sees a
                // config for the inbox that is on the same chain as the outbox. Which
                // fundamentally does not make sense. When we are parsing configs like this we
                // have a bunch of things with slightly overlapping views so this allows us to
                // ignore the overlap that we do not want.
                let ignore_prefixes = [
                    format!("HYP_BASE_INBOXES_{chain_name}"),
                    format!("HYP_SCRAPER_INBOXES_{chain_name}"),
                ];
                let settings: DomainSettings = load_settings_object(
                    &format!("scraper_{chain_name}"),
                    Some(&config_file_name),
                    &ignore_prefixes,
                )
                .with_context(|| {
                    format!("Loading config for chain {chain_name} from {config_file_name}")
                })?;
                let domain: u32 = settings.outbox.domain.parse().expect("Invalid uint");
                Ok((domain, settings))
            })
            .collect::<eyre::Result<_>>()?;
        Ok(Self {
            app,
            chains: chain_settings,
        })
    }
}
