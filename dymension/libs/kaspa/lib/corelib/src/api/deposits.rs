use tracing::info;

use url::Url;

use eyre::{Error, Result};

use std::hash::{BuildHasher, Hash, Hasher, RandomState};

use kaspa_consensus_core::tx::TransactionId;

use api_rs::apis::kaspa_addresses_api::{
    get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page,
    GetFullTransactionsForAddressPageAddressesKaspaAddressFullTransactionsPageGetParams as args,
};
use api_rs::models::TxModel;

use super::client::get_config;

#[derive(Debug, Clone)]
pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub payload: Vec<u8>,
    // #[serde(with = "serde_bytes_fixed_ref")] // TODO: need?
    pub id: TransactionId,
    accepted: bool,
}

impl Hash for Deposit {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

impl PartialEq for Deposit {
    #[inline(always)]
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for Deposit {}

impl TryFrom<TxModel> for Deposit {
    type Error = Error;

    fn try_from(tx: TxModel) -> Result<Self> {
        let id = tx
            .transaction_id
            .ok_or(eyre::eyre!("Transaction ID is missing"))?;
        let payload = tx
            .payload
            .ok_or(eyre::eyre!("Transaction payload is missing"))?; // TODO: payload can definitely be missing!
        let accepted = tx
            .is_accepted
            .ok_or(eyre::eyre!("Transaction accepted is missing"))?;
        let bz = id.as_bytes();
        let tx_id = TransactionId::try_from(bz)?;
        let payload_bz = payload.as_bytes().to_vec();

        Ok(Deposit {
            id: tx_id,
            payload: payload_bz,
            accepted: accepted,
        })
    }
}

pub fn get_deposits() -> Vec<Deposit> {
    info!("FOOBAR get_deposits");
    unimplemented!()
}

#[derive(Debug, Clone)]
pub struct HttpClient {
    pub url: Url,
    client: reqwest::Client, // TODO: ignored for now
}

impl HttpClient {
    pub fn new(url: Url) -> Self {
        Self {
            url,
            client: reqwest::Client::new(),
        }
    }

    pub async fn get_deposits(&self, address: &str) -> Result<Vec<Deposit>> {
        let limit = 20;
        let lower_bound = Some(0i64);
        let upper_bound = Some(0i64);
        let field = None;
        let resolve_previous_outpoints = None;
        let acceptance = None;

        let c = get_config(&self.url);
        info!("FOO|GET_DEPOSITS_CONFIG c: {:?}", c.base_path);

        let res = transactions_page(
            &c, // TODO: need to share this instance across multiple requests
            args {
                kaspa_address: address.to_string(),
                limit: Some(limit),
                before: lower_bound,
                after: upper_bound,
                fields: field,
                resolve_previous_outpoints: resolve_previous_outpoints,
                acceptance: acceptance,
            },
        )
        .await?;

        Ok(res
            .into_iter()
            .map(Deposit::try_from)
            .collect::<Result<Vec<Deposit>>>()?)
    }
}
