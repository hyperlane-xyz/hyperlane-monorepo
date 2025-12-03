use {
    crate::utils::{dango_helper::ChainHelper, get_free_port, try_for},
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
    block_time: grug::Duration,
    port: Option<u16>,
    genesis_option: Option<GenesisOption>,
}

impl DangoBuilder {
    pub fn new(chain_id: &str, hyperlane_domain: u32) -> Self {
        Self {
            chain_id: chain_id.to_string(),
            hyperlane_domain,
            block_creation: BlockCreation::Timed,
            block_time: TestOption::preset_test().block_time,
            port: None,
            genesis_option: None,
        }
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    pub fn with_block_time(mut self, block_time: grug::Duration) -> Self {
        self.block_time = block_time;
        self
    }

    pub fn with_block_creation(mut self, block_creation: BlockCreation) -> Self {
        self.block_creation = block_creation;
        self
    }

    pub fn with_genesis_option(mut self, genesis_option: GenesisOption) -> Self {
        self.genesis_option = Some(genesis_option);
        self
    }

    pub async fn run(self) -> anyhow::Result<ChainHelper> {
        // find a free port
        let port = self.port.unwrap_or_else(get_free_port);

        let test_accounts = Arc::new(Mutex::new(None));

        let thread_test_accounts = test_accounts.clone();

        let domain = self.hyperlane_domain;
        let chain_id = self.chain_id.clone();

        let mut genesis_option = self
            .genesis_option
            .unwrap_or_else(|| GenesisOption::preset_test());
        genesis_option.hyperlane.local_domain = self.hyperlane_domain;

        thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();

            rt.block_on(async move {
                dango_mock_httpd::run_with_callback(
                    port,
                    self.block_creation,
                    None,
                    TestOption {
                        chain_id: self.chain_id,
                        block_time: self.block_time,
                        ..Preset::preset_test()
                    },
                    genesis_option,
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
