use {
    crate::utils::{try_for, DangoBuilder},
    dango_client::{Secp256k1, Secret, SingleSigner},
    dango_genesis::{GatewayOption, GenesisOption, HyperlaneOption},
    dango_hyperlane_types::isms::multisig::ValidatorSet,
    dango_testing::{constants::user5, Preset},
    dango_types::{
        config::AppConfig,
        constants::dango,
        gateway::{self, Origin, Remote},
    },
    grug::{
        BroadcastClientExt, Coins, GasOption, QueryClientExt, ResultExt, SearchTxClient,
        __private::hex_literal::hex, addr, btree_map, btree_set,
    },
    grug_indexer_client::HttpClient,
    std::time::Duration,
    tracing::Level,
};

pub mod utils;

const PORT: u16 = 8080;

#[tokio::test]
#[ignore]
async fn run_dango() -> anyhow::Result<()> {
    // --- SETTINGS ---

    let routes = [(
        Origin::Local(dango::DENOM.clone()),
        Remote::Warp {
            domain: 11155111,
            contract: addr!("34dc3f292fc04e3dcc2830ac69bb5d4cd5e8f654").into(),
        },
    )];

    let ism_validator_sets = btree_map! {
        11155111 => ValidatorSet {
            threshold: 1,
            validators: btree_set!{
                hex!("b22b65f202558adf86a8bb2847b76ae1036686a5").into(),
                hex!("469f0940684d147defc44f3647146cb90dd0bc8e").into(),
                hex!("d3c75dcf15056012a4d74c483a0c6ea11d8c2b83").into(),
            },
        },
    };

    // --- END SETTINGS ---

    let subscriber = tracing_subscriber::FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .expect("failed to set global tracing subscriber");

    let mut warp_routes = GenesisOption::preset_test().gateway.warp_routes;
    warp_routes.extend(routes);

    let mut ism_valset = HyperlaneOption::preset_test().ism_validator_sets;
    ism_valset.extend(ism_validator_sets);

    DangoBuilder::new("localdango", 88888888)
        .with_block_creation(grug::BlockCreation::Timed)
        .with_block_time(grug::Duration::from_seconds(1))
        .with_port(PORT)
        .with_genesis_option(GenesisOption {
            gateway: GatewayOption {
                warp_routes,
                ..Preset::preset_test()
            },
            hyperlane: HyperlaneOption {
                ism_validator_sets: ism_valset,
                ..Preset::preset_test()
            },
            ..Preset::preset_test()
        })
        .run()
        .await?;

    loop {}
}

#[tokio::test]
#[ignore]
async fn transfer_remote() -> anyhow::Result<()> {
    // --- SETTINGS ---

    let url = format!("http://localhost:{}", PORT);
    let denom = dango::DENOM.clone();
    let amount = 55;
    let remote = Remote::Warp {
        domain: 11155111,
        contract: addr!("34dc3f292fc04e3dcc2830ac69bb5d4cd5e8f654").into(),
    };
    let recipient = addr!("f63130398dE6467a539020ac2B6d876B7A850C5F");

    let dango_client = HttpClient::new(url)?;

    let cfg: AppConfig = dango_client.query_app_config(None).await?;
    let chain_id = dango_client.query_status(None).await?.chain_id;

    let mut user5 = SingleSigner::new(
        &user5::USERNAME.clone().to_string(),
        addr!("a20a0e1a71b82d50fc046bc6e3178ad0154fd184"),
        Secp256k1::from_bytes(user5::PRIVATE_KEY)?,
    )?
    .with_query_nonce(&dango_client)
    .await?;

    let res = dango_client
        .execute(
            &mut user5,
            cfg.addresses.gateway,
            &gateway::ExecuteMsg::TransferRemote {
                remote,
                recipient: recipient.into(),
            },
            Coins::one(denom, amount)?,
            GasOption::Predefined { gas_limit: 1000000 },
            &chain_id,
        )
        .await?;

    let outcome = try_for(
        Duration::from_secs(10),
        Duration::from_millis(100),
        || async { dango_client.search_tx(res.tx_hash).await },
    )
    .await?;

    outcome.outcome.should_succeed();

    println!("found at height: {}", outcome.height);

    Ok(())
}
