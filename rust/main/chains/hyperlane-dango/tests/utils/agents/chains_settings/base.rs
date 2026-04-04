use {
    crate::utils::{agents::traits::Args, dango_helper::IntoSignerConf},
    grug::btree_map,
    hyperlane_base::settings::SignerConf,
    std::collections::BTreeMap,
};

#[derive(Debug)]
pub struct ChainSettings<C> {
    pub(crate) chain_name: String,
    chain_signer: Option<ChainSigner>,
    index: Option<IndexSettings>,
    chain: C,
}

impl<C> ChainSettings<C>
where
    C: Default,
{
    pub fn new<S: Into<String>>(chain_name: S) -> Self {
        Self {
            chain_name: chain_name.into(),
            chain_signer: None,
            index: None,
            chain: C::default(),
        }
    }
}

impl<C> ChainSettings<C> {
    pub fn with_chain_settings(mut self, callback: impl FnOnce(&mut C)) -> Self {
        callback(&mut self.chain);
        self
    }

    pub fn with_chain_signer<S: IntoSignerConf>(mut self, chain_signer: S) -> Self {
        self.chain_signer = Some(ChainSigner(GeneralSigner(chain_signer.as_signer_conf())));
        self
    }

    pub fn with_index(mut self, from: u64, chunk_size: Option<u32>) -> Self {
        self.index = Some(IndexSettings { from, chunk_size });
        self
    }
}

impl<C> Args for ChainSettings<C>
where
    C: Args,
{
    fn args(self) -> BTreeMap<String, String> {
        let prefix = format!("chains.{}", self.chain_name);
        let mut args = BTreeMap::new();
        args.extend(self.chain_signer.args_with_prefix(&prefix));
        args.extend(self.chain.args_with_prefix(&prefix));
        args.extend(self.index.args_with_prefix(&prefix));
        args
    }
}

// --- Chain Signer ---

#[derive(Debug)]
struct GeneralSigner(SignerConf);

impl Args for GeneralSigner {
    fn args(self) -> BTreeMap<String, String> {
        match self.0 {
            SignerConf::HexKey { key } => btree_map! {
                "type".to_string() => "hexKey".to_string(),
                "key".to_string() => format!("{:?}", key)
            },
            SignerConf::Dango { key, address } => btree_map! {
                "type".to_string() => "dangoKey".to_string(),
                "key".to_string() => key.to_string(),
                "address".to_string() => address.to_string(),
            },
            _ => unimplemented!(),
        }
    }
}

#[derive(Debug)]
struct ChainSigner(GeneralSigner);

impl Args for ChainSigner {
    fn args(self) -> BTreeMap<String, String> {
        self.0.args_with_prefix("signer")
    }
}

// --- Index ---

#[derive(Debug)]
struct IndexSettings {
    from: u64,
    chunk_size: Option<u32>,
}

impl Args for IndexSettings {
    fn args(self) -> BTreeMap<String, String> {
        let mut args = btree_map! {
            "index.from".to_string() => self.from.to_string(),
        };

        if let Some(chunk_size) = self.chunk_size {
            args.insert("index.chunk".to_string(), chunk_size.to_string());
        }

        args
    }
}
