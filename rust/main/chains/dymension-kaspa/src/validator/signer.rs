use ethers::signers::{LocalWallet, Signer};
use ethers::utils::hex;
use kaspa_bip32::secp256k1::rand::thread_rng;

pub struct EthereumStyleSigner {
    pub address: String,
    pub private_key: String,
}

// Tested here: https://github.com/dymensionxyz/hyperlane-cosmos/blob/b0c2d20ccf5f8f02bfeab9ba9478e7c88d0ff91d/x/core/01_interchain_security/keeper/kas_test.go#L28-L30
pub fn get_ethereum_style_signer() -> Result<EthereumStyleSigner, eyre::Error> {
    let wallet = LocalWallet::new(&mut thread_rng());

    let private_key_bytes = wallet.signer().to_bytes();
    let private_key_hex = hex::encode(private_key_bytes).to_string();

    let address = wallet.address();

    let address_str = serde_json::to_string(&address).unwrap();

    Ok(EthereumStyleSigner {
        address: address_str,
        private_key: private_key_hex,
    })
}
