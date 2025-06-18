use tracing::{debug, error, info, info_span, warn, Instrument};

use url::Url;

use eyre::{Error, Result};

use kaspa_consensus_core::tx::Transaction;

use api_rs::apis::configuration::Configuration;
use api_rs::apis::kaspa_addresses_api::get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page;
use api_rs::models::TxModel;

pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub transaction: Transaction,
}

impl TryFrom<TxModel> for Deposit {
    type Error = Error;

    fn try_from(tx: TxModel) -> Result<Self> {
        let id = tx.transaction_id.ok_or(eyre::eyre!("Transaction ID is missing"))?;
        let payload = tx.payload.ok_or(eyre::eyre!("Transaction payload is missing"))?;
        let accepted = tx.is_accepted.ok_or(eyre::eyre!("Transaction accepted is missing"))?;
        Ok(Deposit {
            transaction: Transaction {
                id,
                payload: tx.payload,
                accepted: tx.accepted,
            },
        })
    }
}

pub fn get_deposits() -> Vec<Deposit> {
    info!("FOOBAR get_deposits");
    unimplemented!()
}

#[derive(Debug)]
pub struct HttpClient {
    url: Url,
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
            .map(|tx| Deposit {
                tx_id: tx.tx_id,
                block_height: tx.block_height,
                block_time: tx.block_time,
                amount: tx.amount,
            })
            .collect())
    }
}
