use api_rs::apis::configuration::Configuration;
use tracing::info;

use url::Url;

use eyre::{Error, Result};

use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use std::hash::{BuildHasher, Hash, Hasher, RandomState};
use std::str::FromStr;

use kaspa_consensus_core::tx::TransactionId;
use kaspa_hashes::Hash as KaspaHash;

use api_rs::apis::kaspa_addresses_api::{
    get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page,
    GetFullTransactionsForAddressPageAddressesKaspaAddressFullTransactionsPageGetParams as args,
};
use api_rs::models::{TxModel, TxOutput};

use super::client::{get_client, get_config};

#[derive(Debug, Clone)]
pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub payload: String,
    // #[serde(with = "serde_bytes_fixed_ref")] // TODO: need?
    pub id: TransactionId,
    accepted: bool,
    pub outputs: Vec<TxOutput>,
    pub block_hash: Vec<String>,
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
        let tx_id = tx
            .transaction_id
            .ok_or(eyre::eyre!("Transaction ID is missing"))?;
        let payload = tx
            .payload
            .ok_or(eyre::eyre!("Transaction payload is missing"))?; // TODO: payload can definitely be missing!
        let accepted = tx
            .is_accepted
            .ok_or(eyre::eyre!("Transaction accepted is missing"))?;
        let tx_hash = KaspaHash::from_str(&tx_id)?;
        let outputs = tx.outputs.ok_or(eyre::eyre!("outputs are missing"))?; // TODO: outputs may be missing!
        let block_hash = tx.block_hash.ok_or(eyre::eyre!("Block hash is missing"))?;

        Ok(Deposit {
            id: tx_hash,
            payload: payload,
            accepted: accepted,
            outputs: outputs,
            block_hash: block_hash,
        })
    }
}

pub fn get_deposits() -> Vec<Deposit> {
    info!("FOOBAR get_deposits");
    unimplemented!()
}

#[derive(Debug, Clone)]
pub struct HttpClient {
    pub url: String,
    client: ClientWithMiddleware,
}

impl HttpClient {
    pub fn new(url: String) -> Self {
        let c = get_client();
        Self { url, client: c }
    }

    pub async fn get_deposits(&self, address: &str) -> Result<Vec<Deposit>> {
        let limit = 20;
        let lower_bound = Some(0i64);
        let upper_bound = Some(0i64);
        let field = None;
        let resolve_previous_outpoints = None;
        let acceptance = None;

        let c = self.get_config();
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
            .filter(|tx| {
                tx.is_accepted.expect("accepted not found in tx")
                    && is_valid_escrow_transfer(tx, &address.to_string())
                        .expect("unable to validate txs")
            })
            .map(Deposit::try_from)
            .collect::<Result<Vec<Deposit>>>()?)
    }

    pub fn get_config(&self) -> Configuration {
        get_config(&self.url, self.client.clone())
    }
}

fn is_valid_escrow_transfer(tx: &TxModel, address: &String) -> Result<bool> {
    if let Some(output) = &tx.outputs {
        for utxo in output {
            if let Some(dest) = utxo.script_public_key_address.as_ref() {
                if dest == address {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}
