use std::{cmp::max, sync::atomic::AtomicU32};

use base64::Engine;
use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    utils, ChainCommunicationError, ChainResult, ReorgPeriod, H160, H256,
};
use reqwest::Error;
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use tendermint::block::Height;
use tendermint_rpc::endpoint::abci_query::{self, AbciQuery};
use tonic::async_trait;

use crate::HyperlaneCosmosError;

use super::cosmos::CosmosFallbackProvider;

#[derive(Debug, Clone)]
struct RestClient {
    url: String,
}

/// Rest Provider
///
/// Responsible for making requests to the Hyperlane Cosmos Rest API
#[derive(Debug, Clone)]
pub struct RestProvider {
    clients: CosmosFallbackProvider<RestClient>,
}

/// Incremental Tree
///
/// contains the branch and count of the tree
#[derive(serde::Deserialize, Clone, Debug)]
pub struct IncrementalTree {
    /// base64 encoded strings
    pub branch: [String; 32],
    /// leaf count
    pub count: usize,
}

/// Mailbox
///
/// contains the mailbox information
#[derive(serde::Deserialize, Clone, Debug)]
pub struct Mailbox {
    /// 32 byte hex string
    pub id: String,
    /// bech32 encoded address
    pub creator: String,
    /// number of messages sent
    pub message_sent: usize,
    /// number of messages received
    pub message_received: usize,
    /// 32 byte hex string, address of the default ism
    pub default_ism: String,
    /// cucrrent incremental tree of the mailbox
    pub tree: IncrementalTree,
}

/// MultiSig ISM
///
/// contains the validator public keys and threshold
#[derive(serde::Deserialize, Clone, Debug)]
pub struct MultiSig {
    /// ethereum addresses of the validators
    pub validator_pub_keys: Vec<String>,
    /// threshold for the multi sig to be valid
    pub threshold: usize,
}

/// ISM Types
///
/// There are multiple ISM Types: MultiSigISM and NoOpISM
/// Each ISM has base fields containing its id, creator and ism_type
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(untagged)] // this is needed because the ISM can be either NoOpISM or MultiSigISM
pub enum ISM {
    /// Multisig ISM
    MultiSigISM {
        /// 32 byte hex string
        id: String,
        /// bech32 encoded address
        creator: String,
        /// type of ISM (MultiSig)
        ism_type: usize,
        /// MultiSig relevant values like validators and threshold
        multi_sig: MultiSig,
    },
    /// NoOp ISM
    NoOpISM {
        /// 32 byte hex string
        id: String,
        /// bech32 encoded address
        creator: String,
        /// type of ISM (NoOp)
        ism_type: usize,
    },
}

/// List of mailboxes
#[derive(serde::Deserialize, Clone, Debug)]
pub struct MailboxesResponse {
    mailboxes: Vec<Mailbox>,
}

/// Mailbox Response
#[derive(serde::Deserialize, Clone, Debug)]
pub struct MailboxResponse {
    mailbox: Mailbox,
}

/// List of ISM
#[derive(serde::Deserialize, Clone, Debug)]
pub struct ISMResponse {
    isms: Vec<ISM>,
}

/// Represents a single warp route configuration
///
/// Contains information about token bridging routes including
/// identifiers, token types, and destination details
#[derive(serde::Deserialize, Clone, Debug)]
pub struct WarpRoute {
    /// 32 byte hex encoded address
    pub id: String,
    /// bech32 encoded address
    pub creator: String,
    /// Type of token being bridged
    pub token_type: String,
    /// 32 byte hex encoded address
    pub origin_mailbox: String,
    /// Original denomination of the token
    pub origin_denom: String,
    /// Domain ID of the receiver chain
    pub receiver_domain: usize,
    /// 32 byte hex encoded address. NOTE: 20 byte address are padded to with zeros to 32 bytes
    pub receiver_contract: String,
}

/// Response wrapper for warp routes query
#[derive(serde::Deserialize, Clone, Debug)]
pub struct WarpRoutesResponse {
    /// List of available warp routes
    pub tokens: Vec<WarpRoute>,
}

/// Response containing a count value
#[derive(serde::Deserialize, Clone, Debug)]
pub struct CountResponse {
    /// The count value
    pub count: u32,
}

/// Response indicating message delivery status
#[derive(serde::Deserialize, Clone, Debug)]
pub struct DeliveredResponse {
    /// Whether the message has been delivered
    pub delivered: bool,
}

/// Status information about a Cosmos node
#[derive(serde::Deserialize, Clone, Debug)]
pub struct NodeStatus {
    /// The earliest block height stored in the node
    #[serde(deserialize_with = "string_to_number")]
    pub earliest_store_height: usize,
    /// Current block height of the node
    #[serde(deserialize_with = "string_to_number")]
    pub height: usize,
}

/// Response containing an ISM identifier
#[derive(serde::Deserialize, Clone, Debug)]
pub struct RecipientIsmResponse {
    /// The identifier of the ISM. 32 byte hex encoded address
    ism_id: String,
}

/// Response containing the latest checkpoint information
#[derive(serde::Deserialize, Clone, Debug)]
pub struct LatestCheckpointResponse {
    /// The merkle root encoded as a base64 string
    pub root: String,
    /// leaf count for that checkpoint
    pub count: u32,
}

/// Response containing validator storage locations
///
/// Contains a list of storage location strings for validators
#[derive(serde::Deserialize, Clone, Debug)]
pub struct ValidatorStorageLocationsResponse {
    /// List of storage locations for the validator
    storage_locations: Vec<String>,
}

#[async_trait]
impl BlockNumberGetter for RestClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let url = self.url.to_owned() + "cosmos/base/node/v1beta1/status";
        let response = reqwest::get(url.clone())
            .await
            .map_err(HyperlaneCosmosError::from)?;
        let result: Result<NodeStatus, Error> = response.json().await;
        match result {
            Ok(result) => Ok(result.height as u64),
            Err(err) => Err(HyperlaneCosmosError::ParsingFailed(format!(
                "Failed to parse response for: {:?} {:?}",
                url, err
            ))
            .into()),
        }
    }
}

impl RestProvider {
    /// Returns a new Rest Provider
    pub fn new(urls: impl IntoIterator<Item = String>) -> RestProvider {
        let provider = FallbackProvider::new(urls.into_iter().map(|url| RestClient { url }));
        RestProvider {
            clients: CosmosFallbackProvider::new(provider),
        }
    }

    async fn get<T>(&self, path: &str, reorg_period: ReorgPeriod) -> ChainResult<T>
    where
        T: DeserializeOwned,
    {
        self.clients
            .call(move |client| {
                let reorg_period = reorg_period.clone();
                let path = path.to_owned();
                let future = async move {
                    let final_url = client.url.to_string() + "hyperlane/v1/" + &path;
                    let request = reqwest::Client::new();
                    let response = match reorg_period {
                        ReorgPeriod::None => request
                            .get(final_url.clone())
                            .send()
                            .await
                            .map_err(HyperlaneCosmosError::from)?,
                        ReorgPeriod::Blocks(non_zero) => {
                            let remote_height = client.get_block_number().await?;
                            if (non_zero.get() as u64) > remote_height {
                                return Err(ChainCommunicationError::InvalidRequest {
                                    msg: "reorg period can not be greater than block height."
                                        .to_string(),
                                });
                            }
                            let delta = remote_height - non_zero.get() as u64;
                            request
                                .get(final_url.clone())
                                .header("x-cosmos-block-height", delta)
                                .send()
                                .await
                                .map_err(HyperlaneCosmosError::from)?
                        }
                        ReorgPeriod::Tag(_) => todo!(),
                    };

                    let result: Result<T, Error> = response.json().await;
                    match result {
                        Ok(result) => Ok(result),
                        Err(err) => Err(HyperlaneCosmosError::ParsingFailed(format!(
                            "Failed to parse response for: {:?} {:?}",
                            final_url, err
                        ))
                        .into()),
                    }
                };
                Box::pin(future)
            })
            .await
    }

    /// list of all mailboxes deployed
    pub async fn mailboxes(&self, reorg_period: ReorgPeriod) -> ChainResult<Vec<Mailbox>> {
        let mailboxes: MailboxesResponse = self.get("mailboxes", reorg_period).await?;
        Ok(mailboxes.mailboxes)
    }

    /// list of all mailboxes deployed
    pub async fn mailbox(&self, id: H256, reorg_period: ReorgPeriod) -> ChainResult<Mailbox> {
        let mailboxes: MailboxResponse =
            self.get(&format!("mailboxes/{id:?}"), reorg_period).await?;
        Ok(mailboxes.mailbox)
    }

    /// list of all isms
    pub async fn isms(&self, reorg_period: ReorgPeriod) -> ChainResult<Vec<ISM>> {
        let isms: ISMResponse = self.get("isms", reorg_period).await?;
        Ok(isms.isms)
    }

    /// list of all warp routes
    pub async fn warp_tokens(&self, reorg_period: ReorgPeriod) -> ChainResult<Vec<WarpRoute>> {
        let warp: WarpRoutesResponse = self.get("tokens", reorg_period).await?;
        Ok(warp.tokens)
    }

    /// returns the current leaf count for mailbox
    pub async fn leaf_count(&self, mailbox: H256, reorg_period: ReorgPeriod) -> ChainResult<u32> {
        let leafs: CountResponse = self
            .get(&format!("mailboxes/{mailbox:?}/tree/count"), reorg_period)
            .await?;
        Ok(leafs.count)
    }

    /// returns the current leaf count for mailbox
    pub async fn leaf_count_at_height(&self, mailbox: H256, height: u32) -> ChainResult<u32> {
        self.clients
            .call(move |client| {
                let mailbox = mailbox.clone();
                let future = async move {
                    let final_url = &format!(
                        "{}/hyperlane/v1/mailboxes/{mailbox:?}/tree/count",
                        client.url
                    );
                    let client = reqwest::Client::new();
                    let response = client
                        .get(final_url.clone())
                        .header("x-cosmos-block-height", height)
                        .send()
                        .await
                        .map_err(HyperlaneCosmosError::from)?;

                    let result: Result<CountResponse, Error> = response.json().await;
                    match result {
                        Ok(result) => Ok(result.count),
                        Err(err) => Err(HyperlaneCosmosError::ParsingFailed(format!(
                            "Failed to parse response for: {:?} {:?} height:{height}",
                            final_url, err
                        ))
                        .into()),
                    }
                };
                Box::pin(future)
            })
            .await
    }

    /// returns if the message id has been delivered
    pub async fn delivered(&self, message_id: H256) -> ChainResult<bool> {
        let response: DeliveredResponse = self
            .get(&format!("delivered/{message_id:?}"), ReorgPeriod::None)
            .await?;
        Ok(response.delivered)
    }

    /// returns the latest checkpoint
    pub async fn latest_checkpoint(
        &self,
        mailbox: H256,
        height: ReorgPeriod,
    ) -> ChainResult<LatestCheckpointResponse> {
        let response: LatestCheckpointResponse = self
            .get(
                &format!("mailboxes/{mailbox:?}/tree/latest_checkpoint"),
                height,
            )
            .await?;
        Ok(response)
    }

    /// returns the recipient ism
    pub async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let response: RecipientIsmResponse = self
            .get(&format!("recipient_ism/{recipient:?}"), ReorgPeriod::None)
            .await?;
        utils::hex_or_base58_to_h256(&response.ism_id).map_err(|e| {
            HyperlaneCosmosError::AddressError("invalid recipient ism address".to_string()).into()
        })
    }

    /// mailbox/v1/announced_storage_locations/{validator_address}
    pub async fn validator_storage_locations(&self, validator: H256) -> ChainResult<Vec<String>> {
        let validator = H160::from(validator);
        let response: ValidatorStorageLocationsResponse = self
            .get(
                &format!("announced_storage_locations/{validator:?}"),
                ReorgPeriod::None,
            )
            .await?;
        Ok(response.storage_locations)
    }
}

fn string_to_number<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    s.parse::<usize>().map_err(serde::de::Error::custom)
}
