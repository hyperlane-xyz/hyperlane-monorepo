use {
    crate::utils::{agents::traits::Args, ChainSettings},
    dango_types::config::AppConfig,
    ethers::types::H160,
    grug::{btree_map, JsonSerExt},
    std::collections::BTreeMap,
};

pub type DangoSettings = ChainSettings<Dango>;

#[derive(Debug, Default)]
pub struct Dango {
    cfg: Option<AppCfgWrapper>,
    chain_id: Option<ChainId>,
    httpd_urls: Option<HttpdUrls>,
}

impl Dango {
    pub fn with_app_cfg(&mut self, cfg: AppConfig) -> &mut Self {
        self.cfg = Some(AppCfgWrapper(cfg));
        self
    }
    pub fn with_chain_id(&mut self, chain_id: String) -> &mut Self {
        self.chain_id = Some(ChainId(chain_id));
        self
    }
    pub fn with_httpd_urls<I, S>(&mut self, httpd_urls: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.httpd_urls = Some(HttpdUrls(
            httpd_urls
                .into_iter()
                .map(|s| s.as_ref().to_string())
                .collect(),
        ));
        self
    }
}

impl Args for Dango {
    fn args(self) -> BTreeMap<String, String> {
        let mut args = BTreeMap::new();
        args.extend(self.cfg.args());
        args.extend(self.chain_id.args());
        args.extend(self.httpd_urls.args());
        args
    }
}

#[derive(Debug)]
struct ChainId(String);

impl Args for ChainId {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "chain_id".to_string() => self.0,
        }
    }
}

#[derive(Debug)]
struct HttpdUrls(Vec<String>);

impl Args for HttpdUrls {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "httpd_urls".to_string() => self.0.to_json_string().unwrap(),
        }
    }
}

#[derive(Debug)]
pub struct AppCfgWrapper(AppConfig);

impl Args for AppCfgWrapper {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "mailbox".to_string() => format!("{}", self.0.addresses.hyperlane.mailbox),
            "merkleTreeHook".to_string() => format!("{}", self.0.addresses.hyperlane.mailbox),
            "validatorAnnounce".to_string() => format!("{}", self.0.addresses.hyperlane.va),
            "interchainGasPaymaster".to_string() => format!("{:?}", H160::zero()),
        }
    }
}
