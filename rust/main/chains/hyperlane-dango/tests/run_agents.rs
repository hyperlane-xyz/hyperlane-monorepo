use {
    crate::utils::{build_agents, Agent, DangoSettings, EvmSettings, Relayer},
    dango_testing::constants::user4,
    grug::{addr, HexByteArray, QueryClientExt},
    grug_indexer_client::HttpClient,
    hyperlane_base::settings::SignerConf,
};

pub mod utils;

#[tokio::test]
async fn run_relayer2() -> anyhow::Result<()> {
    build_agents();

    let dango_client = HttpClient::new("https://api-pr-1414-ovh2.dango.zone")?;
    let app_cfg = dango_client.query_app_config(None).await?;

    Agent::new(Relayer::default())
        .with_chain(EvmSettings::new("sepolia").with_index(9712111, Some(20)))
        .with_chain(
            DangoSettings::new("dangolocal2")
                .with_chain_signer(SignerConf::Dango {
                    username: user4::USERNAME.clone(),
                    key: HexByteArray::from_inner(user4::PRIVATE_KEY),
                    address: addr!("5a7213b5a8f12e826e88d67c083be371a442689c"),
                })
                .with_index(739345, Some(200))
                .with_chain_settings(|dango| {
                    dango.with_app_cfg(app_cfg);
                    dango.with_chain_id("pr-1414".to_string());
                    dango.with_httpd_urls(["https://api-pr-1414-ovh2.dango.zone"]);
                }),
        )
        .launch();

    loop {}
}
