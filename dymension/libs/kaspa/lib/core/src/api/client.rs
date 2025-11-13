use super::base::RateLimitConfig;
use std::hash::{Hash, Hasher};
use std::str::FromStr;

use kaspa_consensus_core::tx::TransactionId;
use kaspa_hashes::Hash as KaspaHash;

use super::base::{get_client, get_config};
use api_rs::apis::configuration::Configuration;
use api_rs::apis::kaspa_addresses_api::get_balance_from_kaspa_address_addresses_kaspa_address_balance_get as get_balance;
use api_rs::apis::kaspa_addresses_api::GetBalanceFromKaspaAddressAddressesKaspaAddressBalanceGetParams;
use api_rs::apis::kaspa_addresses_api::{
    get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get as transactions_page,
    GetFullTransactionsForAddressPageAddressesKaspaAddressFullTransactionsPageGetParams as args,
};
use api_rs::apis::kaspa_network_info_api::health_state_info_health_get as get_health;
use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get as get_tx_by_id,
    GetTransactionTransactionsTransactionIdGetParams as get_tx_by_id_params,
};
use api_rs::models::{AcceptanceMode, TxModel, TxOutput};
use eyre::{Error, Result};
use reqwest_middleware::ClientWithMiddleware;
use tracing::info;

#[derive(Debug, Clone)]
pub struct Deposit {
    // ATM its a part of Transaction struct, only id, payload, accepted are populated
    pub payload: Option<String>,
    // #[serde(with = "serde_bytes_fixed_ref")] // TODO: need?
    pub id: TransactionId,
    pub time: i64,
    pub accepted: bool,
    pub outputs: Vec<TxOutput>,
    pub accepting_block_hash: String,
    pub accepting_block_time: i64,
    pub accepting_block_blue_score: i64,
    pub block_hashes: Vec<String>,
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
        let time = tx.block_time.ok_or(eyre::eyre!("Block time not set"))?;
        let accepting_block_hash = tx
            .accepting_block_hash
            .ok_or(eyre::eyre!("Accepting block hash is missing"))?;
        let accepting_block_blue_score = tx
            .accepting_block_blue_score
            .ok_or(eyre::eyre!("Accepting block blue score is missing"))?;
        let accepting_block_time = tx
            .accepting_block_time
            .ok_or(eyre::eyre!("Accepting block time is missing"))?;
        let block_hashes = tx
            .block_hash
            .ok_or(eyre::eyre!("Block hashes are missing"))?;

        Ok(Deposit {
            id: tx_hash,
            payload: tx.payload,
            accepted,
            outputs,
            time,
            accepting_block_hash,
            accepting_block_time,
            accepting_block_blue_score,
            block_hashes,
        })
    }
}

#[derive(Debug, Clone)]
pub struct HttpClient {
    pub url: String,
    client: ClientWithMiddleware,
}

impl HttpClient {
    pub fn new(url: String, config: RateLimitConfig) -> Self {
        let c = get_client(config);
        info!(url = %url, "created Kaspa REST API Client");
        Self { url, client: c }
    }

    pub async fn get_deposits_by_address(
        &self,
        lower_bound_unix_time: Option<i64>,
        address: &str,
    ) -> Result<Vec<Deposit>> {
        let n: i64 = 500;
        let initial_lower_bound_t = lower_bound_unix_time.unwrap_or(0);
        let mut upper_bound_t = 0i64;

        let c = self.get_config();
        info!(url = ?c.base_path, "dymension query kaspa deposits");

        let mut txs: Vec<TxModel> = Vec::new();

        let mut lower_bound_t = initial_lower_bound_t;
        loop {
            // only upper_bound_t or lower_bound_t can be used in the query, not both.
            // so in case upper_bound_t is set (>0) it means we need to page and we use the last tx received timestamp as upper_bound_t
            if upper_bound_t > 0 {
                lower_bound_t = 0;
            }

            let mut res = transactions_page(
                &c,
                args {
                    kaspa_address: address.to_string(),
                    limit: Some(n),
                    before: Some(upper_bound_t),
                    after: Some(lower_bound_t),
                    fields: None,
                    resolve_previous_outpoints: None,
                    acceptance: Some(AcceptanceMode::Accepted),
                },
            )
            .await?;

            let txs_found = res.len();
            // txs should be in descendent order, so we save last returned tx time and we continue from there
            if let Some(last_val) = res.last() {
                if let Some(t) = last_val.block_time {
                    upper_bound_t = t - 1;
                }
            }
            txs.append(&mut res);

            // if txs found are less than n, or we already did paging till the initial lower bound
            if txs_found < n as usize || upper_bound_t < initial_lower_bound_t {
                break;
            }
        }

        // return txs filtered by txs that include utxos with destination escrow address and including a payload
        txs.into_iter()
            .filter(|tx| {
                is_valid_escrow_transfer(tx, &address.to_string()).expect("unable to validate txs")
                    && tx.payload.is_some()
                    && tx.is_accepted.unwrap_or(false)
            })
            .map(Deposit::try_from)
            .collect::<Result<Vec<Deposit>>>()
    }

    pub fn get_config(&self) -> Configuration {
        let u = self.url.clone();
        let url = u.strip_suffix("/").unwrap();
        get_config(url, self.client.clone())
    }

    // TODO: we should pass block hash hint in validator (he can get it from relayer)
    pub async fn get_tx_by_id(&self, tx_id: &str) -> Result<TxModel> {
        info!(tx_id = ?tx_id, "querying kaspa tx by id");
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

    pub async fn get_tx_by_id_slim(
        &self,
        tx_id: &str,
        block_hash_hint: Option<String>,
    ) -> Result<TxModel> {
        info!(tx_id = ?tx_id, "querying kaspa tx by id slim");
        let c = self.get_config();

        let tx = get_tx_by_id(
            &c,
            get_tx_by_id_params {
                transaction_id: tx_id.to_string(),
                block_hash: block_hash_hint,
                inputs: Some(false),
                outputs: Some(false),
                resolve_previous_outpoints: Some("no".to_string()),
            },
        )
        .await?;
        Ok(tx)
    }

    pub async fn get_blue_score(&self) -> Result<i64> {
        let c = self.get_config();
        let res = get_health(&c).await?;
        let blue_score = res
            .database
            .blue_score
            .ok_or(eyre::eyre!("Blue score is missing"))?;
        Ok(blue_score)
    }

    pub async fn get_balance_by_address(&self, address: &str) -> Result<i64> {
        let c = self.get_config();
        let res = get_balance(
            &c,
            GetBalanceFromKaspaAddressAddressesKaspaAddressBalanceGetParams {
                kaspa_address: address.to_string(),
            },
        )
        .await?;
        match res.balance {
            Some(balance) => Ok(balance),
            None => Err(eyre::eyre!("Balance is missing")),
        }
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
    use super::*;

    #[tokio::test]
    #[ignore = "dont hil real api"]
    async fn test_get_deposits() {
        // https://explorer-tn10.kaspa.org/addresses/kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr?page=1
        let client = HttpClient::new(
            "https://api-tn10.kaspa.org/".to_string(),
            RateLimitConfig::default(),
        );
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
    #[ignore]
    async fn test_get_tx_by_id() {
        let client = HttpClient::new(
            "https://api-tn10.kaspa.org/".to_string(),
            RateLimitConfig::default(),
        );
        let tx_id = "1ffa672605af17906d99ba9506dd49406a2e8a3faa2969ab0c8929373aca51d1";
        let tx = client.get_tx_by_id(tx_id).await;
        println!("Tx: {:?}", tx);
    }
}
