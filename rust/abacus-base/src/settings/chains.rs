use eyre::Report;
use serde::Deserialize;

use abacus_core::{ContractLocator, Signers};
use abacus_ethereum::{
    Connection, InboxBuilder, InboxValidatorManagerBuilder, MakeableWithProvider, OutboxBuilder,
};

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

/// Addresses for outbox chain contracts
#[derive(Clone, Debug, Deserialize, Default)]
pub struct OutboxAddresses {
    /// Address of the Outbox contract
    pub outbox: String,
}

/// Addresses for inbox chain contracts
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboxAddresses {
    /// Address of the Inbox contract
    pub inbox: String,
    /// Address of the InboxValidatorManager contract
    pub validator_manager: String,
}

/// A chain setup is a domain ID, an address on that chain (where the outbox or
/// inbox is deployed) and details for connecting to the chain API.
#[derive(Clone, Debug, Deserialize, Default)]
pub struct ChainSetup<T> {
    /// Chain name
    pub name: String,
    /// Chain domain identifier
    pub domain: String,
    /// Addresses of contracts on the chain
    pub addresses: T,
    /// The chain connection details
    #[serde(flatten)]
    pub chain: ChainConf,
    /// Set this key to disable the inbox. Does nothing for outboxes.
    #[serde(default)]
    pub disabled: Option<String>,
}

impl ChainSetup<OutboxAddresses> {
    /// Try to convert the chain setting into a Outbox contract
    pub async fn try_into_outbox(&self, signer: Option<Signers>) -> Result<Outboxes, Report> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(OutboxVariants::Ethereum(
                OutboxBuilder {}
                    .make_with_connection(
                        conf.clone(),
                        &ContractLocator {
                            name: self.name.clone(),
                            domain: self.domain.parse().expect("invalid uint"),
                            address: self
                                .addresses
                                .outbox
                                .parse::<ethers::types::Address>()?
                                .into(),
                        },
                        signer,
                    )
                    .await?,
            )
            .into()),
        }
    }
}

impl ChainSetup<InboxAddresses> {
    /// Try to convert the chain setting into an inbox contract
    pub async fn try_into_inbox(&self, signer: Option<Signers>) -> Result<Inboxes, Report> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(InboxVariants::Ethereum(
                InboxBuilder {}
                    .make_with_connection(
                        conf.clone(),
                        &ContractLocator {
                            name: self.name.clone(),
                            domain: self.domain.parse().expect("invalid uint"),
                            address: self
                                .addresses
                                .inbox
                                .parse::<ethers::types::Address>()?
                                .into(),
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
        // inbox_address: Address,
    ) -> Result<InboxValidatorManagers, Report> {
        let inbox_address = self.addresses.inbox.parse::<ethers::types::Address>()?;
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(InboxValidatorManagerVariants::Ethereum(
                InboxValidatorManagerBuilder { inbox_address }
                    .make_with_connection(
                        conf.clone(),
                        &ContractLocator {
                            name: self.name.clone(),
                            domain: self.domain.parse().expect("invalid uint"),
                            address: self
                                .addresses
                                .validator_manager
                                .parse::<ethers::types::Address>()?
                                .into(),
                        },
                        signer,
                    )
                    .await?,
            )
            .into()),
        }
    }
}
