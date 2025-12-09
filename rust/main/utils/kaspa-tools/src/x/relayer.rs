use dymension_kaspa::kas_validator::signer::{get_ethereum_style_signer, EthereumStyleSigner};

pub fn create_relayer() -> EthereumStyleSigner {
    get_ethereum_style_signer().unwrap()
}
