use std::ops::Deref;

use aleo_serialize::AleoSerialize;
use anyhow::Result;
use async_trait::async_trait;
use derive_new::new;
use serde::de::DeserializeOwned;
use snarkvm::ledger::query::QueryTrait;
use snarkvm::ledger::{Block, ConfirmedTransaction};
use snarkvm::prelude::{
    Authorization, Network, Plaintext, Program, ProgramID, StatePath, Transaction,
};

use hyperlane_core::ChainResult;
use snarkvm_console_account::Field;

use crate::{CurrentNetwork, HyperlaneAleoError, ProvingRequest, ProvingResponse};

#[async_trait]
/// HttpClient trait defines the base layer that Aleo provider will use
pub trait HttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T>;

    /// Makes a GET request to the API in a blocking manner
    fn request_blocking<T: DeserializeOwned>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T>;

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T>;
}

/// Implements high level Aleo RPC requests based on a raw HttpClient
#[derive(Debug, Clone, new)]
pub struct RpcClient<Client: HttpClient>(Client);

#[derive(serde::Deserialize)]
struct MappingValueWithMeta {
    data: Plaintext<CurrentNetwork>,
    height: u32,
}

impl<T: HttpClient> Deref for RpcClient<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<Client: HttpClient> RpcClient<Client> {
    /// Gets the latest block
    pub async fn get_latest_block(&self) -> ChainResult<Block<CurrentNetwork>> {
        self.request("block/latest", None).await
    }

    /// Gets the latest block height
    pub async fn get_latest_height(&self) -> ChainResult<u32> {
        self.request("block/height/latest", None).await
    }

    /// Gets the latest block hash
    pub async fn get_latest_hash(&self) -> ChainResult<String> {
        self.request("block/hash/latest", None).await
    }

    /// Finds the block hash containing a transaction
    pub async fn find_block_hash_by_transaction_id(
        &self,
        transaction_id: &str,
    ) -> ChainResult<String> {
        self.request(&format!("find/blockHash/{transaction_id}"), None)
            .await
    }

    /// Gets a block by height
    pub async fn get_block<N: Network>(&self, height: u32) -> ChainResult<Block<N>> {
        self.request(&format!("block/{height}"), None).await
    }

    /// Gets a block by hash
    pub async fn get_block_by_hash<N: Network>(&self, hash: &str) -> ChainResult<Block<N>> {
        self.request(&format!("block/{hash}"), None).await
    }

    /// Gets all transactions in a block
    pub async fn get_block_transactions(
        &self,
        height_or_hash: &str,
    ) -> ChainResult<Vec<Transaction<CurrentNetwork>>> {
        self.request(&format!("block/{height_or_hash}/transactions"), None)
            .await
    }

    /// Gets a program by ID
    pub async fn get_program<N: Network>(
        &self,
        program_id: &ProgramID<N>,
    ) -> ChainResult<Program<N>> {
        self.request(&format!("program/{program_id}"), None).await
    }

    /// Gets a program by ID and edition
    pub async fn get_program_by_edition(
        &self,
        program_id: &str,
        edition: u64,
        metadata: Option<bool>,
    ) -> ChainResult<String> {
        let query = metadata.map(|m| serde_json::json!({ "metadata": m }));
        self.request(&format!("program/{program_id}/{edition}"), query)
            .await
    }

    /// Gets all mappings for a program
    pub async fn get_program_mappings(&self, program_id: &str) -> ChainResult<Vec<String>> {
        self.request(&format!("program/{program_id}/mappings"), None)
            .await
    }

    /// Gets a value from a program mapping
    pub async fn get_mapping_value_raw<N: Network, T: AleoSerialize<N>, K: AleoSerialize<N>>(
        &self,
        program_id: &str,
        mapping_name: &str,
        mapping_key: &K,
    ) -> ChainResult<T> {
        let plaintext_key = mapping_key
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;
        let plain_text: Plaintext<N> = self
            .request(
                &format!("program/{program_id}/mapping/{mapping_name}/{plaintext_key}"),
                None,
            )
            .await?;
        let result = T::parse_value(plain_text).map_err(HyperlaneAleoError::from)?;
        Ok(result)
    }

    /// Gets a value from a program mapping
    pub async fn get_mapping_value<
        T: AleoSerialize<CurrentNetwork>,
        K: AleoSerialize<CurrentNetwork>,
    >(
        &self,
        program_id: &str,
        mapping_name: &str,
        mapping_key: &K,
    ) -> ChainResult<T> {
        let plaintext_key = mapping_key
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;
        let plain_text: Plaintext<CurrentNetwork> = self
            .request(
                &format!("program/{program_id}/mapping/{mapping_name}/{plaintext_key}"),
                None,
            )
            .await?;
        let result = T::parse_value(plain_text).map_err(HyperlaneAleoError::from)?;
        Ok(result)
    }

    /// Gets a value from a program mapping
    pub async fn get_mapping_value_meta<T: AleoSerialize<CurrentNetwork>>(
        &self,
        program_id: &str,
        mapping_name: &str,
        mapping_key: &str,
    ) -> ChainResult<(T, u32)> {
        let response: MappingValueWithMeta = self
            .request(
                &format!("program/{program_id}/mapping/{mapping_name}/{mapping_key}"),
                Some(serde_json::json!({ "metadata": true })),
            )
            .await?;
        let plain_text = response.data;
        let result = T::parse_value(plain_text).map_err(HyperlaneAleoError::from)?;
        Ok((result, response.height))
    }

    /// Gets a transaction by ID
    pub async fn get_transaction(
        &self,
        transaction_id: &str,
    ) -> ChainResult<Transaction<CurrentNetwork>> {
        self.request(&format!("transaction/{transaction_id}"), None)
            .await
    }

    /// Gets a transaction by ID
    pub async fn get_transaction_status(
        &self,
        transaction_id: &str,
    ) -> ChainResult<ConfirmedTransaction<CurrentNetwork>> {
        self.request(&format!("transaction/confirmed/{transaction_id}"), None)
            .await
    }

    /// Broadcasts a transaction
    /// Returns either the resulting tx_id or the failure reason
    pub async fn broadcast_transaction<N: Network>(
        &self,
        transaction: Transaction<N>,
    ) -> ChainResult<String> {
        let body = serde_json::to_value(transaction).map_err(HyperlaneAleoError::from)?;
        self.request_post("transaction/broadcast", &body).await
    }
}

/// Implements high level Aleo Proofing Service requests based on a raw HttpClient
#[derive(Debug, Clone, new)]
pub struct ProofingClient<Client: HttpClient>(Client);

impl<Client: HttpClient> ProofingClient<Client> {
    /// Makes a POST request to the API
    pub async fn proofing_request<N: Network>(
        &self,
        authorization: Authorization<N>,
        fee: Authorization<N>,
    ) -> ChainResult<Transaction<N>> {
        let authorization = serde_json::to_value(authorization)?;
        let fee_authorization = serde_json::to_value(fee)?;

        let request = ProvingRequest {
            authorization,
            fee_authorization: Some(fee_authorization),
            broadcast: false,
        };
        let body = serde_json::to_value(request).map_err(HyperlaneAleoError::from)?;

        let response: ProvingResponse = self.0.request_post("/prove", &body).await?;

        Ok(
            serde_json::from_value::<Transaction<N>>(response.transaction)
                .map_err(HyperlaneAleoError::from)?,
        )
    }
}

#[async_trait(?Send)]
impl<Client: HttpClient, N: Network> QueryTrait<N> for RpcClient<Client> {
    /// Returns the current state root.
    fn current_state_root(&self) -> Result<N::StateRoot> {
        Ok(self.request_blocking("stateRoot/latest", None)?)
    }

    /// Returns the current state root.
    async fn current_state_root_async(&self) -> Result<N::StateRoot> {
        Ok(self.request("stateRoot/latest", None).await?)
    }

    /// Returns a state path for the given `commitment`.
    fn get_state_path_for_commitment(&self, commitment: &Field<N>) -> Result<StatePath<N>> {
        Ok(self.request_blocking(&format!("statePath/{commitment}"), None)?)
    }

    /// Returns a state path for the given `commitment`.
    async fn get_state_path_for_commitment_async(
        &self,
        commitment: &Field<N>,
    ) -> Result<StatePath<N>> {
        Ok(self
            .request(&format!("statePath/{commitment}"), None)
            .await?)
    }

    /// Returns a list of state paths for the given list of `commitment`s.
    fn get_state_paths_for_commitments(
        &self,
        commitments: &[Field<N>],
    ) -> Result<Vec<StatePath<N>>> {
        let commitments_string = commitments
            .iter()
            .map(|cm| cm.to_string())
            .collect::<Vec<_>>()
            .join(",");
        Ok(self
            .request_blocking(
                &format!("statePaths?commitments={commitments_string}"),
                None,
            )
            .unwrap_or_default())
    }

    /// Returns a list of state paths for the given list of `commitment`s.
    async fn get_state_paths_for_commitments_async(
        &self,
        commitments: &[Field<N>],
    ) -> Result<Vec<StatePath<N>>> {
        let commitments_string = commitments
            .iter()
            .map(|cm| cm.to_string())
            .collect::<Vec<_>>()
            .join(",");
        Ok(self
            .request(
                &format!("statePaths?commitments={commitments_string}"),
                None,
            )
            .await
            .unwrap_or_default())
    }

    /// Returns the current block height
    fn current_block_height(&self) -> Result<u32> {
        Ok(self.request_blocking("block/height/latest", None)?)
    }

    /// Returns the current block height
    async fn current_block_height_async(&self) -> Result<u32> {
        Ok(self.get_latest_height().await?)
    }
}
