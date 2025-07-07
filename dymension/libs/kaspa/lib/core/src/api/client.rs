use api_rs::apis::configuration::Configuration;
use tracing::info;

use url::Url;

use eyre::{Error, Result};

use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use std::hash::{BuildHasher, Hash, Hasher, RandomState};
use std::str::FromStr;
use std::time::Duration;

use kaspa_consensus_core::tx::TransactionId;
use kaspa_hashes::Hash as KaspaHash;

use api_rs::apis::kaspa_addresses_api::{
    get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page,
    GetFullTransactionsForAddressPageAddressesKaspaAddressFullTransactionsPageGetParams as args,
};
use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get as get_tx_by_id,
    GetTransactionTransactionsTransactionIdGetParams as get_tx_by_id_params,
};
use api_rs::models::{TxModel, TxOutput};

use super::base::{get_client, get_config};

#[derive(Debug, Clone)]
pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub payload: Option<String>,
    // #[serde(with = "serde_bytes_fixed_ref")] // TODO: need?
    pub id: TransactionId,
    pub time: i64,
    pub accepted: bool,
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
        let accepted = tx
            .is_accepted
            .ok_or(eyre::eyre!("Transaction accepted is missing"))?;
        let tx_hash = KaspaHash::from_str(&tx_id)?;
        let outputs = tx.outputs.ok_or(eyre::eyre!("Outputs are missing"))?; // TODO: outputs may be missing!
        let block_hash = tx.block_hash.ok_or(eyre::eyre!("Block hash is missing"))?;
        let time = tx.block_time.ok_or(eyre::eyre!("Block time not set"))?;

        Ok(Deposit {
            id: tx_hash,
            payload: tx.payload,
            accepted: accepted,
            outputs: outputs,
            time: time,
            block_hash: block_hash,
        })
    }
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

    pub async fn get_deposits_by_address(
        &self,
        lower_bound_unix_time: Option<i64>,
        address: &str,
    ) -> Result<Vec<Deposit>> {
        let n: i64 = 500;
        let mut lower_bound_t = lower_bound_unix_time.unwrap_or(0);
        let upper_bound_t = std::time::SystemTime::now()
            .checked_sub(Duration::from_secs(10))
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let c = self.get_config();
        info!("Dymension query kaspa deposits, url: {:?}", c.base_path);

        let mut txs: Vec<TxModel> = Vec::new();

        while lower_bound_t < upper_bound_t {
            let mut res = transactions_page(
                &c,
                args {
                    kaspa_address: address.to_string(),
                    limit: Some(n),
                    after: Some(lower_bound_t),
                    before: Some(upper_bound_t),
                    fields: None,
                    resolve_previous_outpoints: None,
                    acceptance: None,
                },
            )
            .await?;
            txs.append(&mut res);
            if res.len() < n as usize {
                break;
            }
            // txs should be in descendent order, so we save last returned tx time and we continue from there
            if let Some(last_val) = res.last() {
                if let Some(t) = last_val.block_time {
                    lower_bound_t = t + 1;
                }
            }
        }

        // return txs filtered by txs that include utxos with destination escrow address and including a payload
        Ok(txs
            .into_iter()
            .filter(|tx| {
                is_valid_escrow_transfer(tx, &address.to_string()).expect("unable to validate txs")
                    && tx.payload.is_some()
            })
            .map(Deposit::try_from)
            .collect::<Result<Vec<Deposit>>>()?)
    }

    pub fn get_config(&self) -> Configuration {
        let u = self.url.clone();
        let url = u.strip_suffix("/").unwrap();
        get_config(&url, self.client.clone())
    }

    pub async fn get_tx_by_id(&self, tx_id: &str) -> Result<TxModel> {
        let c = self.get_config();
        let tx = get_tx_by_id(
            &c,
            get_tx_by_id_params {
                transaction_id: tx_id.to_string(),
                block_hash: None,
                inputs: Some(true),
                outputs: Some(true),
                resolve_previous_outpoints: Some("light".to_string()),
            },
        )
        .await?;
        Ok(tx)
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

#[cfg(test)]
mod tests {
    use kaspa_core::time::unix_now;

    use super::*;

    #[tokio::test]
    #[ignore = "avoid api abuse"]
    async fn test_get_deposits() {
        // https://explorer-tn10.kaspa.org/addresses/kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr?page=1
        let client = HttpClient::new("https://api-tn10.kaspa.org/".to_string());
        let address = "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr";

        let deposits = client
            .get_deposits_by_address(Some(1751299515650), address)
            .await;

        match deposits {
            Ok(deposits) => {
                println!("Found deposits: n = {:?}", deposits.len());
                for deposit in deposits {
                    println!("Deposit: {:?}", deposit);
                }
            }
            Err(e) => {
                println!("Query deposits: {:?}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_tx_by_id() {
        let client = HttpClient::new("https://api-tn10.kaspa.org/".to_string());
        let tx_id = "1ffa672605af17906d99ba9506dd49406a2e8a3faa2969ab0c8929373aca51d1";
        let tx = client.get_tx_by_id(tx_id).await;
        println!("Tx: {:?}", tx);
    }
}
