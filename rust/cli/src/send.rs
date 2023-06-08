use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use crate::domains::validate_domain;
use crate::key;
use ethers::abi::Address;
use ethers::prelude::SignerMiddleware;
use ethers::providers::{Http, Provider};
use ethers::signers::LocalWallet;
use ethers::signers::Signer;
use hyperlane_core::{
    ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox, H256,
};
use hyperlane_ethereum::{self, EthereumMailbox};

use anyhow::Result;

#[derive(Debug, clap::Args)]
pub struct SendArgs {
    #[arg(value_parser = validate_domain)]
    domain: KnownHyperlaneDomain,
    recipient: Address,
    message: String,
    private_key: PathBuf,
    /// URL override, useful when default CLI provided URL does not work.
    url: Option<String>,
}

impl SendArgs {
    pub async fn process(self) -> Result<()> {
        // https://docs.hyperlane.xyz/docs/resources/addresses
        //
        // TODO: parse ../../mainnet_config.json and ../../testnet_config.json to
        // programatically obtain contract addresses. Then drop hardcoded url
        // and validate the passed url by querying chain_id from the node.
        let (origin_contract, mut url) = match self.domain {
            KnownHyperlaneDomain::Goerli => (
                Address::from_str("0xCC737a94FecaeC165AbCf12dED095BB13F037685")?,
                "https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161".to_string(),
            ),
            _ => anyhow::bail!("TODO: {} is not yet supported", self.domain),
        };

        if let Some(u) = self.url {
            url = u;
        }

        let wallet: LocalWallet = key::get_ethereum_signing_key(&self.private_key)?
            .parse::<LocalWallet>()?
            .with_chain_id(self.domain as u32);
        let provider = Provider::<Http>::try_from(url)?;
        let client = SignerMiddleware::new(provider.clone(), wallet);
        let locator = ContractLocator {
            domain: &HyperlaneDomain::Known(self.domain),
            address: H256::from(origin_contract),
        };
        let mailbox = EthereumMailbox::new(Arc::new(client), &locator);
        let mut message = HyperlaneMessage::default();
        message.origin = self.domain as u32;
        message.recipient = H256::from(self.recipient);
        message.body = self.message.into_bytes();
        let cost = mailbox.process_estimate_costs(&message, &[]).await?;
        let result = mailbox.process(&message, &[], Some(cost.gas_limit)).await?;
        println!("{:?}", result);

        Ok(())
    }
}
