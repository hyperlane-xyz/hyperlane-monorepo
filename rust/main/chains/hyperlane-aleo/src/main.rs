use std::str::FromStr;

use anyhow::Result;
use hyperlane_aleo::{
    AleoMerkleTreeHook, AleoProvider, AleoSigner, ConnectionConf, CurrentNetwork,
};
use hyperlane_core::{ContractLocator, HyperlaneDomain, H256};
use hyperlane_core::{Indexer, SequenceAwareIndexer};
use snarkvm::prelude::{Plaintext, ProgramID, Value};
use snarkvm_console_account::bech32;
use url::Url;

#[tokio::main]
async fn main() -> Result<()> {
    let private_key =
        hex::decode("5e5b34fbf0e6e22375fde0d2af0dcd789bd607a9423ece32bc281d7a28fa3612")?;
    let signer = AleoSigner::new(&private_key)?;

    let domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);
    let url = Url::parse("http://localhost:3030/testnet")?;
    let config = ConnectionConf::new(
        vec![url],
        "".to_owned(),
        "hook_manager.aleo".to_owned(),
        "".to_owned(),
        "".to_owned(),
    );
    let provider = AleoProvider::new(&config, domain.clone(), Some(signer));

    let address = hex::decode("8565069977e03d6b1e8528b592aa68a38e516489be46b81087804a0f4fe33710")?;
    let locator = ContractLocator::new(&domain, H256::from_slice(&address));

    let indexer = AleoMerkleTreeHook::new(provider, &locator, &config);

    let result = indexer.fetch_logs_in_range(0..=50).await;
    println!("{:#?}", result);

    Ok(())
}
