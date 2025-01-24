use std::cmp::max;

use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    utils, ChainCommunicationError, ChainResult, ReorgPeriod, H160, H256,
};
use reqwest::Error;
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use tonic::async_trait;

use crate::HyperlaneCosmosError;

use super::CosmosFallbackProvider;

#[derive(Debug, Clone)]
struct RestClient {
    url: String,
}

#[derive(Debug, Clone)]
pub struct RestProvider {
    clients: CosmosFallbackProvider<RestClient>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct IncrementalTree {
    pub branch: Vec<String>, // base64 encoded
    pub count: usize,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct Mailbox {
    pub id: String,
    pub creator: String,
    pub message_sent: usize,
    pub message_received: usize,
    pub default_ism: String,
    pub tree: IncrementalTree,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct MultiSig {
    pub validator_pub_keys: Vec<String>,
    pub threshold: usize,
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(untagged)] // this is needed because the ISM can be either NoOpISM or MultiSigISM
pub enum ISM {
    MultiSigISM {
        id: String,
        creator: String,
        ism_type: usize,
        multi_sig: MultiSig,
    },
    NoOpISM {
        id: String,
        ism_type: usize,
        creator: String,
    },
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct MailboxesResponse {
    mailboxes: Vec<Mailbox>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct MailboxResponse {
    mailbox: Mailbox,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct ISMResponse {
    isms: Vec<ISM>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct WarpRoute {
    pub id: String,
    pub creator: String,
    pub token_type: String,
    pub origin_mailbox: String,
    pub origin_denom: String,
    pub receiver_domain: usize,
    pub receiver_contract: String,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct WarpRoutesResponse {
    pub tokens: Vec<WarpRoute>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct CountResponse {
    pub count: u32,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct DeliveredResponse {
    pub delivered: bool,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct NodeStatus {
    #[serde(deserialize_with = "string_to_number")]
    pub earliest_store_height: usize,
    #[serde(deserialize_with = "string_to_number")]
    pub height: usize,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct RecipientIsmResponse {
    ism_id: String,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct LatestCheckpointResponse {
    pub root: String, // encoded base64 string
    pub count: u32,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct ValidatorStorageLocationsResponse {
    storage_locations: Vec<String>,
}

#[async_trait]
impl BlockNumberGetter for RestClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let url = self.url.to_owned() + "cosmos/base/node/v1beta1/status";
        let response = reqwest::get(url.clone())
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?;
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
    #[doc = "todo"]
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
                    let final_url = client.url.to_string() + "hyperlane/" + &path;
                    let request = reqwest::Client::new();
                    let response = match reorg_period {
                        ReorgPeriod::None => request
                            .get(final_url.clone())
                            .send()
                            .await
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                        ReorgPeriod::Blocks(non_zero) => {
                            let remote_height = client.get_block_number().await?;
                            if non_zero.get() as u64 > remote_height {
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
                                .map_err(Into::<HyperlaneCosmosError>::into)?
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
        let mailboxes: MailboxesResponse = self.get("mailbox/v1/mailboxes", reorg_period).await?;
        Ok(mailboxes.mailboxes)
    }

    /// list of all mailboxes deployed
    pub async fn mailbox(&self, id: H256, reorg_period: ReorgPeriod) -> ChainResult<Mailbox> {
        let mailboxes: MailboxResponse = self
            .get(&format!("mailbox/v1/mailboxes/{id:?}"), reorg_period)
            .await?;
        Ok(mailboxes.mailbox)
    }

    /// list of all isms
    pub async fn isms(&self, reorg_period: ReorgPeriod) -> ChainResult<Vec<ISM>> {
        let isms: ISMResponse = self.get("ism/v1/isms", reorg_period).await?;
        Ok(isms.isms)
    }

    /// list of all warp routes
    pub async fn warp_tokens(&self, reorg_period: ReorgPeriod) -> ChainResult<Vec<WarpRoute>> {
        let warp: WarpRoutesResponse = self.get("warp/v1/tokens", reorg_period).await?;
        Ok(warp.tokens)
    }

    /// returns the current leaf count for mailbox
    pub async fn leaf_count(&self, mailbox: H256, reorg_period: ReorgPeriod) -> ChainResult<u32> {
        let leafs: CountResponse = self
            .get(&format!("mailbox/v1/tree/count/{mailbox:?}"), reorg_period)
            .await?;
        Ok(leafs.count)
    }

    /// returns the current leaf count for mailbox
    pub async fn leaf_count_at_height(&self, mailbox: H256, height: u32) -> ChainResult<u32> {
        self.clients
            .call(move |client| {
                let mailbox = mailbox.clone();
                let future = async move {
                    let final_url =
                        &format!("{}/hyperlane/mailbox/v1/tree/count/{mailbox:?}", client.url);
                    let client = reqwest::Client::new();
                    let response = client
                        .get(final_url.clone())
                        .header("x-cosmos-block-height", height)
                        .send()
                        .await
                        .map_err(Into::<HyperlaneCosmosError>::into)?;

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
            .get(
                &format!("mailbox/v1/delivered/{message_id:?}"),
                ReorgPeriod::None,
            )
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
                &format!("mailbox/v1/tree/latest_checkpoint/{mailbox:?}"),
                height,
            )
            .await?;
        Ok(response)
    }

    /// returns the recipient ism
    pub async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let response: RecipientIsmResponse = self
            .get(
                &format!("mailbox/v1/recipient_ism/{recipient:?}"),
                ReorgPeriod::None,
            )
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
                &format!("mailbox/v1/announced_storage_locations/{validator:?}"),
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
