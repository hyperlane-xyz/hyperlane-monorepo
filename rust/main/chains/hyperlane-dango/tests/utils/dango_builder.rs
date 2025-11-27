use {
    crate::utils::{dango_helper::ChainHelper, get_free_port, try_for},
    dango_genesis::HyperlaneOption,
    dango_mock_httpd::{GenesisOption, Preset, TestOption},
    grug::{BlockCreation, ClientWrapper, QueryClientExt},
    grug_indexer_client::HttpClient,
    std::{
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    },
};

pub struct DangoBuilder {
    chain_id: String,
    hyperlane_domain: u32,
    block_creation: BlockCreation,
}

impl DangoBuilder {
    pub fn new(chain_id: &str, hyperlane_domain: u32) -> Self {
        Self {
            chain_id: chain_id.to_string(),
            hyperlane_domain,
            block_creation: BlockCreation::Timed,
        }
    }

    pub fn with_block_creation(mut self, block_creation: BlockCreation) -> Self {
        self.block_creation = block_creation;
        self
    }

    pub async fn run(self) -> anyhow::Result<ChainHelper> {
        // find a free port
        let port = get_free_port();

        let test_accounts = Arc::new(Mutex::new(None));

        let thread_test_accounts = test_accounts.clone();

        let domain = self.hyperlane_domain;
        let chain_id = self.chain_id.clone();

        thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();

            rt.block_on(async move {
                dango_mock_httpd::run_with_callback(
                    port,
                    self.block_creation,
                    None,
                    TestOption {
                        chain_id: self.chain_id,
                        ..Preset::preset_test()
                    },
                    GenesisOption {
                        hyperlane: HyperlaneOption {
                            local_domain: self.hyperlane_domain,
                            ..Preset::preset_test()
                        },
                        ..Preset::preset_test()
                    },
                    None,
                    |accounts, _, _, _, _| {
                        *thread_test_accounts.lock().unwrap() = Some(accounts);
                    },
                )
                .await
                .unwrap();
            });
        });

        let httpd_url = format!("http://127.0.0.1:{}", port);

        let client = ClientWrapper::new(Arc::new(HttpClient::new(&httpd_url)?));

        while test_accounts.lock().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let accounts = test_accounts.lock().unwrap().take().unwrap();

        try_for(
            Duration::from_secs(10),
            Duration::from_millis(500),
            || async { client.query_status(None).await },
        )
        .await?;

        ChainHelper::new(client, accounts, chain_id, domain, vec![httpd_url]).await
    }
}
