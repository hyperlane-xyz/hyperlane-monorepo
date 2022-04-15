use color_eyre::Report;
use ethers::types::Address;
use serde::Deserialize;

use abacus_core::{ContractLocator, Signers};
use abacus_ethereum::{make_inbox, make_inbox_validator_manager, make_outbox, Connection};

use crate::{
    InboxValidatorManagerVariants, InboxValidatorManagers, InboxVariants, Inboxes, OutboxVariants,
    Outboxes,
};

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
/// Specify the connection details as a toml object under the `connection` key.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "rpcStyle", content = "connection", rename_all = "camelCase")]
pub enum ChainConf {
    /// Ethereum configuration
    Ethereum(Connection),
}

impl Default for ChainConf {
    fn default() -> Self {
        Self::Ethereum(Default::default())
    }
}

/// A chain setup is a domain ID, an address on that chain (where the outbox or
/// inbox is deployed) and details for connecting to the chain API.
#[derive(Clone, Debug, Deserialize, Default)]
pub struct ChainSetup {
    /// Chain name
    pub name: String,
    /// Chain domain identifier
    pub domain: String,
    /// Address of contract on the chain
    pub address: String,
    /// The chain connection details
    #[serde(flatten)]
    pub chain: ChainConf,
    /// Set this key to disable the inbox. Does nothing for outboxes.
    #[serde(default)]
    pub disabled: Option<String>,
}

impl ChainSetup {
    /// Try to convert the chain setting into a Outbox contract
    pub async fn try_into_outbox(&self, signer: Option<Signers>) -> Result<Outboxes, Report> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(OutboxVariants::Ethereum(
                make_outbox(
                    conf.clone(),
                    &ContractLocator {
                        name: self.name.clone(),
                        domain: self.domain.parse().expect("invalid uint"),
                        address: self.address.parse::<ethers::types::Address>()?.into(),
                    },
                    signer,
                )
                .await?,
            )
            .into()),
        }
    }

    /// Try to convert the chain setting into an inbox contract
    pub async fn try_into_inbox(&self, signer: Option<Signers>) -> Result<Inboxes, Report> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(InboxVariants::Ethereum(
                make_inbox(
                    conf.clone(),
                    &ContractLocator {
                        name: self.name.clone(),
                        domain: self.domain.parse().expect("invalid uint"),
                        address: self.address.parse::<ethers::types::Address>()?.into(),
                    },
                    signer,
                )
                .await?,
            )
            .into()),
        }
    }

    /// Try to convert the chain setting into an InboxValidatorManager contract
    pub async fn try_into_inbox_validator_manager(
        &self,
        signer: Option<Signers>,
        inbox_address: Address,
    ) -> Result<InboxValidatorManagers, Report> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(InboxValidatorManagerVariants::Ethereum(
                make_inbox_validator_manager(
                    conf.clone(),
                    &ContractLocator {
                        name: self.name.clone(),
                        domain: self.domain.parse().expect("invalid uint"),
                        address: self.address.parse::<ethers::types::Address>()?.into(),
                    },
                    signer,
                    inbox_address,
                )
                .await?,
            )
            .into()),
        }
    }
}
