use std::{
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

use dango_mock_httpd::{GenesisOption, Preset, TestOption};
use grug::ClientWrapper;
use grug_indexer_client::HttpClient;

use crate::utils::dango_helper::ChainHelper;

pub struct DangoBuilder {
    chain_id: String,
    hyperlane_domain: u32,
}

impl DangoBuilder {
    pub fn new(chain_id: &str, hyperlane_domain: u32) -> Self {
        Self {
            chain_id: chain_id.to_string(),
            hyperlane_domain,
        }
    }

    pub async fn run(self) -> anyhow::Result<ChainHelper> {
        // find a free port
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind");
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let test_accounts = Arc::new(Mutex::new(None));

        let thread_test_accounts = test_accounts.clone();

        let domain = self.hyperlane_domain;
        let chain_id = self.chain_id.clone();

        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();

            rt.block_on(async move {
                dango_mock_httpd::run_with_callback(
                    port,
                    grug::BlockCreation::OnBroadcast,
                    None,
                    TestOption {
                        chain_id: self.chain_id,
                        ..Preset::preset_test()
                    },
                    GenesisOption::preset_test(),
                    true,
                    None,
                    |accounts, _, _, _| {
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

        tokio::time::sleep(Duration::from_secs(1)).await;

        ChainHelper::new(client, accounts, chain_id, domain, httpd_url).await
    }
}
