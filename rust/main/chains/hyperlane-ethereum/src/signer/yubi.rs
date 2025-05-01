use ecdsa::Signature;
use ethers_core::{k256::PublicKey, types::Address, utils::keccak256};
use ethers_signers::Wallet;
use k256::Secp256k1;
use signature::hazmat::PrehashSigner;
use signature::Error;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::{LazyLock, RwLock};
use yubihsm::ecdsa::sec1::FromEncodedPoint;
use yubihsm::ecdsa::sec1::ToEncodedPoint;
use yubihsm::ecdsa::secp256k1::RecoveryId;
use yubihsm::object;
use yubihsm::Client;
use yubihsm::HttpConfig;
use yubihsm::{ecdsa::Signer as YubiSigner, Credentials};

/// Unique key for a yubihsm client in the global cache.
/// The global caches is used so that we can reuse yubihsm sessions across threads, preventing resource exhaustion.
struct YubihsmClientCacheKey {
    config: HttpConfig,
    credentials: Credentials,
    id: object::Id,
}

impl PartialEq for YubihsmClientCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.config.addr == other.config.addr
            && self.config.port == other.config.port
            && self.config.timeout_ms == other.config.timeout_ms
            && self.credentials.authentication_key_id == other.credentials.authentication_key_id
            && self.id == other.id
    }
}

impl Eq for YubihsmClientCacheKey {}

impl Hash for YubihsmClientCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.config.addr.hash(state);
        self.config.port.hash(state);
        self.config.timeout_ms.hash(state);
        self.credentials.authentication_key_id.hash(state);
        self.id.hash(state);
    }
}

/// A thread safe cache for signers against a yubihsm.
/// Yubihsms have a limited number of sessions (16), which remain open for at least 30 seconds. If a number of connections is requested
/// too quickly, the devices resources will become exhausted leading to failures.
static YUBIHSM_CLIENT_CACHE: LazyLock<RwLock<HashMap<YubihsmClientCacheKey, WrappedSigner>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Get a signer.
/// If a matching signer is in the cache, the cached version is returned. Otherwise a new signer is initialized, and added to the cache.
/// This function is thread safe.
fn get_signer_with_cache(
    http_config: HttpConfig,
    credentials: Credentials,
    id: object::Id,
) -> WrappedSigner {
    let cache_key = YubihsmClientCacheKey {
        config: http_config.clone(),
        credentials: credentials.clone(),
        id: id.clone(),
    };

    // If a client already exists for this key, return a clone of the Arc.
    {
        let cache = YUBIHSM_CLIENT_CACHE.read().unwrap();

        if let Some(existing_client) = cache.get(&cache_key) {
            return Arc::clone(existing_client);
        }
    }

    // Build a new client and add it to the cache.
    let client = YubiHsmSigner::connect(http_config, credentials);
    let signer = Arc::new(YubiSigner::create(client, id).expect("unable to create yubihsm signer"));
    {
        let mut cache = YUBIHSM_CLIENT_CACHE.write().unwrap();
        cache.insert(cache_key, Arc::clone(&signer));
    }

    signer
}

/// A wallet connected to a yubihsm2
pub type YubiHsmWallet = Wallet<YubiHsmSigner>;

/// The signer that is wrapped in a thread safe manner.
type WrappedSigner = Arc<yubihsm::ecdsa::Signer<ethers_core::k256::Secp256k1>>;

/// YubiHsmSigner is a signer that is backed by a yubihsm2.
/// It wraps a normal signer in Arc, while implementing Signer for Wallet, such that a Wallet holding a YubiHsmSigner is cloneable.
#[derive(Clone)]
pub struct YubiHsmSigner {
    wrapped: WrappedSigner,
}

impl YubiHsmSigner {
    /// Connect to the yubihsm and return a wallet backed by the connection
    /// Utilizes the global cache.
    pub fn new_wallet(
        http_config: HttpConfig,
        credentials: Credentials,
        id: object::Id,
    ) -> Wallet<Self> {
        let signer = YubiHsmSigner::new(http_config, credentials, id);
        let address = signer.get_address();

        Wallet::new_with_signer(signer, address, 1)
    }

    /// Connect to the yubihsm and return a signer
    pub fn new(http_config: HttpConfig, credentials: Credentials, id: object::Id) -> Self {
        let wrapped = get_signer_with_cache(http_config, credentials, id);

        Self { wrapped }
    }

    /// Performs initial connection to the device and returns an initialized signer.
    /// This function does not use a cache. Care should be taken to not exhaust the number of sessions on the yubihsm when calling this function.
    fn connect(http_config: HttpConfig, credentials: Credentials) -> Client {
        let connector = ethers::signers::yubihsm::Connector::http(&http_config);
        Client::open(connector.clone(), credentials.clone(), true)
            .expect("unable to connect to yubihsm")
    }

    /// Returns the address from the device.
    /// This function will retry indefinitely. This is because yubihsms have a limited number of sessions, and on hyperlane startup, we may
    /// request many signers simultaneously which will temporarily overload the device.
    fn get_address(&self) -> Address {
        // SEE: https://github.com/hyperlane-xyz/ethers-rs/blob/a6cd47a09f4ba16f7ac12242d598b6ac6a328694/ethers-signers/src/wallet/yubi.rs#L59
        let public_key = PublicKey::from_encoded_point(self.wrapped.public_key()).unwrap();
        let public_key = PublicKey::to_encoded_point(/* compress = */ &public_key, false);
        let public_key = public_key.as_bytes();
        debug_assert_eq!(public_key[0], 0x04);
        let hash = keccak256(&public_key[1..]);
        let address: Address = Address::from_slice(&hash[12..]);
        address
    }
}

impl PrehashSigner<(Signature<Secp256k1>, RecoveryId)> for YubiHsmSigner {
    /// Compute a fixed-size secp256k1 ECDSA signature of a digest output along with the recovery
    /// ID.
    fn sign_prehash(&self, prehash: &[u8]) -> Result<(Signature<Secp256k1>, RecoveryId), Error> {
        self.wrapped.sign_prehash(prehash)
    }
}
