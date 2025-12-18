use {
    dango_client::{Secp256k1, Secret, SingleSigner},
    dango_hyperlane_types::{
        domain_hash, eip191_hash,
        isms::{multisig::Metadata, HYPERLANE_DOMAIN_KEY},
        mailbox::Message,
        multisig_hash, Addr32,
    },
    dango_testing::constants::user4,
    dango_types::{config::AppConfig, warp::TokenMessage},
    ethers::{
        contract::abigen,
        providers::{Http, Provider},
        types::H160,
        utils::keccak256,
    },
    grug::{
        Addr, AddrEncoder, Api, BroadcastClientExt, Coins, EncodedBytes, GasOption, Hash256,
        HexByteArray, Inner, Json, JsonDeExt, JsonSerExt, MockApi, QueryClientExt,
        __private::hex_literal::hex, addr, btree_set,
    },
    grug_indexer_client::HttpClient,
    serde::{Deserialize, Serialize},
    std::{
        collections::BTreeSet,
        sync::{Arc, LazyLock},
    },
};

type AddrEncoded<const N: usize> = EncodedBytes<[u8; N], AddrEncoder>;

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckpointResponse {
    pub merkle_tree_hook_address: AddrEncoded<32>,
    pub mailbox_domain: u32,
    pub root: AddrEncoded<32>,
    pub index: u32,
    pub message_id: AddrEncoded<32>,
    pub serialized_signature: AddrEncoded<65>,
}

abigen!(
    ValidatorAnnounce,
    "../hyperlane-ethereum/abis/IValidatorAnnounce.abi.json"
);

abigen!(Mailbox, "../hyperlane-ethereum/abis/IMailbox.abi.json");

abigen!(
    MerkleTreeHook,
    "../hyperlane-ethereum/abis/MerkleTreeHook.abi.json"
);

// --- MESSAGE INFO ---

const BLOCK_NUMBER: u64 = 9718329;
const MESSAGE_ID: [u8; 32] =
    hex!("187a8e60b7cbff99c67d5a2a2f4a5c5cea8d5c4a049fe297c6eb6eafa5ad920e");

// --- ADDRESSES ---

const MAILBOX: [u8; 20] = hex!("fFAEF09B3cd11D9b20d1a19bECca54EEC2884766");
const MERKLE_TREE_HOOK: [u8; 20] = hex!("4917a9746A7B6E0A57159cCb7F5a6744247f2d0d");
const VA: [u8; 20] = hex!("E6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9");

// --- VALSET ---

const VALSET: LazyLock<BTreeSet<H160>> = LazyLock::new(|| {
    btree_set!(
        H160(hex!("b22b65f202558adf86a8bb2847b76ae1036686a5")),
        H160(hex!("469f0940684d147defc44f3647146cb90dd0bc8e")),
        H160(hex!("d3c75dcf15056012a4d74c483a0c6ea11d8c2b83")),
    )
});

// --- DANGO ---

const DANGO_URL: &str = "https://api-pr-1414-ovh2.dango.zone";
const DANGO_PRIVATE_KEY: [u8; 32] = user4::PRIVATE_KEY;
const DANGO_ADDRESS: Addr = addr!("5a7213b5a8f12e826e88d67c083be371a442689c");

#[tokio::test]
#[ignore]
async fn manual_relay() -> anyhow::Result<()> {
    let provider = Arc::new(Provider::<Http>::try_from(
        "https://ethereum-sepolia.publicnode.com",
    )?);

    let mailbox: Mailbox<Provider<Http>> = Mailbox::new(MAILBOX, provider.clone());

    let mth: MerkleTreeHook<Provider<Http>> =
        MerkleTreeHook::new(MERKLE_TREE_HOOK, provider.clone());

    let msg: Option<Message> = mailbox
        .dispatch_filter()
        .from_block(BLOCK_NUMBER)
        .to_block(BLOCK_NUMBER)
        .query()
        .await?
        .into_iter()
        .find_map(|e: DispatchFilter| {
            let body = &e.message;
            if keccak256(body) == MESSAGE_ID {
                Message::decode(body).ok()
            } else {
                None
            }
        });

    let Some(msg) = msg else {
        return Err(anyhow::anyhow!("Message not found"));
    };

    println!("msg: {}", msg.to_json_string_pretty()?);

    let body = TokenMessage::decode(&msg.body)?;

    println!("body: {:#?}", body);

    // panic!();

    let index: Option<u32> = mth
        .inserted_into_tree_filter()
        .from_block(BLOCK_NUMBER)
        .to_block(BLOCK_NUMBER)
        .query()
        .await?
        .into_iter()
        .find_map(|e: InsertedIntoTreeFilter| {
            if e.message_id == MESSAGE_ID {
                Some(e.index)
            } else {
                None
            }
        });

    let Some(index) = index else {
        return Err(anyhow::anyhow!("Index not found"));
    };

    let api = MockApi;

    let mut recovered_addresses: BTreeSet<H160> = BTreeSet::new();
    let mut metadata = Option::<Metadata>::None;

    for location in get_validator_locations(VALSET.clone(), provider.clone()).await? {
        let checkpoint = get_checkpoint_from_s3(&location, &index.to_string()).await?;

        let merkle_tree_hook_address =
            Addr32::from_inner(checkpoint.merkle_tree_hook_address.into_inner());
        let merkle_root = Hash256::from_inner(checkpoint.root.into_inner());
        let message_id = Hash256::from_inner(MESSAGE_ID);
        let serialized_signature = HexByteArray::from(checkpoint.serialized_signature.into_inner());

        if *message_id != MESSAGE_ID {
            return Err(anyhow::anyhow!("Message ID mismatch"));
        }

        let multisig_hash = eip191_hash(multisig_hash(
            domain_hash(
                msg.origin_domain,
                merkle_tree_hook_address,
                HYPERLANE_DOMAIN_KEY,
            ),
            merkle_root,
            checkpoint.index,
            message_id,
        ));

        let pk = api.secp256k1_pubkey_recover(
            &multisig_hash,
            &checkpoint.serialized_signature[..64],
            checkpoint.serialized_signature[64] - 27, // Ethereum uses recovery IDs 27, 28 instead of 0, 1.
            false, // We need the _uncompressed_ public key for deriving address!
        )?;
        let pk_hash = api.keccak256(&pk[1..]);
        let address: [u8; 20] = pk_hash[12..].try_into().unwrap();

        recovered_addresses.insert(H160(address));

        if let Some(metadata) = &mut metadata {
            metadata.signatures.insert(serialized_signature);
        } else {
            metadata = Some(Metadata {
                origin_merkle_tree: merkle_tree_hook_address,
                merkle_root,
                merkle_index: checkpoint.index,
                signatures: btree_set!(serialized_signature),
            });
        }
    }

    assert_eq!(recovered_addresses, VALSET.clone());

    let dango_client = HttpClient::new(DANGO_URL)?;

    let app_config: AppConfig = dango_client.query_app_config(None).await?;
    let chain_id = dango_client.query_status(None).await?.chain_id;

    let mut dango_signer =
        SingleSigner::new(DANGO_ADDRESS, Secp256k1::from_bytes(DANGO_PRIVATE_KEY)?)
            .with_query_nonce(&dango_client)
            .await?
            .with_query_user_index(&dango_client)
            .await?;

    let result = dango_client
        .execute(
            &mut dango_signer,
            app_config.addresses.hyperlane.mailbox,
            &dango_hyperlane_types::mailbox::ExecuteMsg::Process {
                raw_message: msg.encode(),
                raw_metadata: metadata.unwrap().encode(),
            },
            Coins::default(),
            GasOption::Predefined { gas_limit: 1000000 },
            &chain_id,
        )
        .await?;

    println!("result: {}", result.to_json_string_pretty()?);

    Ok(())
}

async fn get_validator_locations<I: IntoIterator<Item = H160>>(
    validators: I,
    provider: Arc<Provider<Http>>,
) -> anyhow::Result<Vec<String>> {
    ValidatorAnnounce::new(VA, provider.clone())
        .get_announced_storage_locations(validators.into_iter().collect())
        .await?
        .into_iter()
        .map(|mut locations: Vec<String>| {
            locations.pop().ok_or(anyhow::anyhow!("Location not found"))
        })
        .collect::<Result<Vec<String>, anyhow::Error>>()
}

pub async fn get_checkpoint_from_s3(s3: &str, index_msg: &str) -> anyhow::Result<CheckpointResponse> {
    let without_scheme = s3
        .strip_prefix("s3://")
        .ok_or(anyhow::anyhow!("Invalid S3 URL"))?;

    let mut parts = without_scheme.splitn(3, '/');

    let bucket = parts.next().ok_or(anyhow::anyhow!("Bucket not found"))?;
    let region = parts.next().ok_or(anyhow::anyhow!("Region not found"))?;
    let key = parts.next().unwrap_or("");

    let url = if key.is_empty() {
        format!("https://{}.s3.{}.amazonaws.com", bucket, region)
    } else {
        format!("https://{}.s3.{}.amazonaws.com/{}", bucket, region, key)
    };

    let url = format!("{}/checkpoint_{}_with_id.json", url, index_msg);

    let json = reqwest::get(url).await?.json::<Json>().await?;

    Ok(CheckpointResponse {
        merkle_tree_hook_address: json["value"]["checkpoint"]["merkle_tree_hook_address"]
            .clone()
            .deserialize_json()?,
        mailbox_domain: json["value"]["checkpoint"]["mailbox_domain"]
            .clone()
            .deserialize_json()?,
        root: json["value"]["checkpoint"]["root"]
            .clone()
            .deserialize_json()?,
        index: json["value"]["checkpoint"]["index"]
            .clone()
            .deserialize_json()?,
        message_id: json["value"]["message_id"].clone().deserialize_json()?,
        serialized_signature: json["serialized_signature"].clone().deserialize_json()?,
    })
}
