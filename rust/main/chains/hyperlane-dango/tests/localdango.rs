use {
    crate::utils::{try_for, DangoBuilder, SingleSignerExt},
    dango_client::{Secp256k1, Secret, SingleSigner},
    dango_genesis::{GatewayOption, GenesisOption, HyperlaneOption},
    dango_hyperlane_types::{
        domain_hash, eip191_hash,
        isms::{multisig::ValidatorSet, HYPERLANE_DOMAIN_KEY},
        mailbox, multisig_hash, Addr32,
    },
    dango_testing::{constants::user5, Preset},
    dango_types::{
        config::AppConfig,
        constants::dango,
        gateway::{self, Origin, Remote},
    },
    grug::{
        addr, btree_map, btree_set, Addr, Api, BroadcastClientExt, CheckedContractEvent, Coins,
        EventName, FlatCommitmentStatus, GasOption, Hash256, Inner, JsonDeExt, MockApi,
        QueryClientExt, ResultExt, SearchEvent, SearchTxClient, __private::hex_literal::hex,
    },
    grug_indexer_client::HttpClient,
    manual_relay::get_checkpoint_from_s3,
    std::time::Duration,
    tracing::Level,
};

pub mod manual_relay;
pub mod utils;

const PORT: u16 = 8080;

#[tokio::test]
#[ignore]
async fn run_dango() -> anyhow::Result<()> {
    // --- SETTINGS ---

    let local_domain = 88888867;

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

    DangoBuilder::new("localdango", local_domain)
        .with_block_creation(grug::BlockCreation::Timed)
        .with_block_time(grug::Duration::from_seconds(1))
        .with_port(PORT)
        .with_genesis_option(GenesisOption {
            gateway: GatewayOption {
                warp_routes,
                ..Preset::preset_test()
            },
            hyperlane: HyperlaneOption {
                local_domain,
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

    let run_recover_address = true;
    let location = "s3://hyperlane-testnet-val1/eu-north-1";
    let recover_address_should_be = addr!("6603760598E4aAc3E9D47569cc3A7024cDa7003a");

    let url = format!("http://localhost:{}", PORT);
    let denom = dango::DENOM.clone();
    let amount = 55;
    let remote = Remote::Warp {
        domain: 11155111,
        contract: addr!("34dc3f292fc04e3dcc2830ac69bb5d4cd5e8f654").into(),
    };
    let recipient = addr!("f63130398dE6467a539020ac2B6d876B7A850C5F");

    // --- SETTINGS ---

    let dango_client = HttpClient::new(url)?;

    let cfg: AppConfig = dango_client.query_app_config(None).await?;
    let chain_id = dango_client.query_status(None).await?.chain_id;

    let mut user5 = SingleSigner::new_first_account(
        &dango_client,
        Secp256k1::from_bytes(user5::PRIVATE_KEY)?,
        Some(&cfg),
    )
    .await?
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
    .await?
    .outcome
    .should_succeed();

    if !run_recover_address {
        return Ok(());
    }

    let dispatch = outcome
        .events
        .clone()
        .search_event::<CheckedContractEvent>()
        .with_commitment_status(FlatCommitmentStatus::Committed)
        .with_predicate(move |e| {
            &e.contract == &cfg.addresses.hyperlane.mailbox && e.ty == mailbox::Dispatch::EVENT_NAME
        })
        .take()
        .one()
        .event
        .data
        .deserialize_json::<mailbox::Dispatch>()?
        .0;

    let insertion = outcome
        .events
        .search_event::<CheckedContractEvent>()
        .with_commitment_status(FlatCommitmentStatus::Committed)
        .with_predicate(move |e| {
            &e.contract == &cfg.addresses.hyperlane.mailbox
                && e.ty == mailbox::InsertedIntoTree::EVENT_NAME
        })
        .take()
        .one()
        .event
        .data
        .deserialize_json::<mailbox::InsertedIntoTree>()?;

    let checkpoint = try_for(
        Duration::from_secs(10),
        Duration::from_millis(100),
        || async { get_checkpoint_from_s3(location, &insertion.index.to_string()).await },
    )
    .await?;

    let api = MockApi;

    let raw_message = dispatch.encode();
    let message_id = Hash256::from_inner(api.keccak256(&raw_message));

    assert_eq!(message_id.inner(), checkpoint.message_id.inner());

    let merkle_tree_hook_address =
        Addr32::from_inner(checkpoint.merkle_tree_hook_address.into_inner());
    let merkle_root = Hash256::from_inner(checkpoint.root.into_inner());

    let multisig_hash = eip191_hash(multisig_hash(
        domain_hash(
            dispatch.origin_domain,
            merkle_tree_hook_address,
            HYPERLANE_DOMAIN_KEY,
        ),
        merkle_root,
        checkpoint.index,
        Hash256::from_inner(checkpoint.message_id.into_inner()),
    ));

    let pk = api.secp256k1_pubkey_recover(
        &multisig_hash,
        &checkpoint.serialized_signature[..64],
        checkpoint.serialized_signature[64] - 27, // Ethereum uses recovery IDs 27, 28 instead of 0, 1.
        false, // We need the _uncompressed_ public key for deriving address!
    )?;
    let pk_hash = api.keccak256(&pk[1..]);
    let address: [u8; 20] = pk_hash[12..].try_into().unwrap();

    assert_eq!(Addr::from_inner(address), recover_address_should_be);

    Ok(())
}
