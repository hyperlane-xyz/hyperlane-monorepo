use tracing::{debug, error, info, info_span, warn, Instrument};

use url::Url;

use eyre::{Error, Result};

use kaspa_consensus_core::tx::{Transaction, TransactionId};

use api_rs::apis::configuration::Configuration;
use api_rs::apis::kaspa_addresses_api::get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page;
use api_rs::models::TxModel;

pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub payload: Vec<u8>,
    // #[serde(with = "serde_bytes_fixed_ref")] // TODO: need?
    id: TransactionId,
    accepted: bool,
}

impl TryFrom<TxModel> for Deposit {
    type Error = Error;

    fn try_from(tx: TxModel) -> Result<Self> {
        let id = tx
            .transaction_id
            .ok_or(eyre::eyre!("Transaction ID is missing"))?;
        let payload = tx
            .payload
            .ok_or(eyre::eyre!("Transaction payload is missing"))?;
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

    fn get_config(&self) -> Configuration {
        Configuration {
            base_path: self.url.to_string(),
            user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
            client: reqwest::Client::new(),
            basic_auth: None,
            oauth_access_token: None,
            bearer_access_token: None,
            api_key: None,
        }
    }

    pub async fn get_deposits(&self, address: &str) -> Result<Vec<Deposit>> {
        let limit = 20;
        let lower_bound = Some(0i64);
        let upper_bound = Some(0i64);
        let field = None;
        let resolve_previous_outpoints = None;
        let acceptance = None;

        let res = transactions_page(
            &self.get_config(),
            address,
            Some(limit),
            lower_bound,
            upper_bound,
            field,
            resolve_previous_outpoints,
            acceptance,
        )
        .await?;

        Ok(res
            .into_iter()
            .map(Deposit::try_from)
            .collect::<Result<Vec<Deposit>>>()?)
    }
}
