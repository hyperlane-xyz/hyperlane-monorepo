use {
    crate::{
        BlockLogs, ClientWrapper, ConnectionConf, DangoConvertor, DangoError, DangoResult,
        DangoSigner, TryDangoConvertor,
    },
    anyhow::anyhow,
    async_trait::async_trait,
    dango_types::{account::spot, auth::Metadata},
    futures_util::future::try_join_all,
    grug::{
        Addr, Binary, Block, BlockClient, BlockOutcome, BroadcastClient, BroadcastClientExt,
        BroadcastTxOutcome, Defined, GasOption, Hash256, Inner, JsonDeExt, JsonSerExt, Message,
        MsgExecute, NonEmpty, Query, QueryClient, QueryClientExt, QueryRequest, QueryResponse,
        SearchTxClient, SearchTxOutcome, Signer, Tx, TxOutcome, UnsignedTx,
    },
    grug_indexer_client::HttpClient,
    hyperlane_core::{
        rpc_clients::{BlockNumberGetter, FallbackProvider},
        BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
        HyperlaneDomain, HyperlaneProvider, ReorgPeriod, TxnInfo, H256, H512, U256,
    },
    serde::{de::DeserializeOwned, Serialize},
    std::{
        ops::{Deref, DerefMut, RangeInclusive},
        str::FromStr,
        sync::Arc,
    },
    tracing::info,
};

#[derive(Clone)]
pub struct DangoProvider {
    pub domain: HyperlaneDomain,
    pub connection_conf: ConnectionConf,
    pub signer: Option<DangoSigner>,
    client: FallbackProvider<ClientWrapper, ClientWrapper>,
}

impl DangoProvider {
    pub fn from_config(
        config: &ConnectionConf,
        domain: &HyperlaneDomain,
        signer: Option<DangoSigner>,
    ) -> DangoResult<Self> {
        let clients = config
            .httpd_urls
            .iter()
            .map(|url| {
                HttpClient::new(url.clone())
                    .map(|client| ClientWrapper::new(grug::ClientWrapper::new(Arc::new(client))))
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(DangoProvider {
            domain: domain.clone(),
            connection_conf: config.clone(),
            signer,
            client: FallbackProvider::new(clients),
        })
    }

    pub async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<BlockLogs>> {
        let tasks = range
            .into_iter()
            .map(|i| async move { self.get_block_logs(i as u64).await })
            .collect::<Vec<_>>();

        try_join_all(tasks).await
    }

    async fn get_block_logs(&self, height: u64) -> ChainResult<BlockLogs> {
        let block = self.query_block(Some(height)).await?;
        let block_result = self.query_block_outcome(Some(height)).await?;

        let txs = block
            .txs
            .into_iter()
            .zip(block_result.tx_outcomes)
            .enumerate()
            .map(|(idx, ((tx, tx_hash), tx_outcome))| SearchTxOutcome {
                hash: tx_hash,
                height,
                index: idx as u32,
                tx,
                outcome: tx_outcome,
            })
            .collect();

        Ok(BlockLogs::new(
            block.info.height,
            block.info.hash,
            txs,
            block_result.cron_outcomes,
        ))
    }

    fn signer(&self) -> DangoResult<DangoSigner> {
        Ok(self
            .signer
            .clone()
            .ok_or(anyhow!("can't use send_message if signer is not specified"))?)
    }

    /// Get transaction info for a given transaction hash and retry if it is not found.
    pub async fn search_tx_loop(&self, hash: Hash256) -> DangoResult<SearchTxOutcome> {
        for _ in 0..self.connection_conf.search_retry_attempts {
            if let Ok(result) = self.search_tx(hash).await {
                return Ok(result);
            }

            tokio::time::sleep(self.connection_conf.search_sleep_duration).await;

            info!("trying next attempt");
        }

        Err(crate::DangoError::TxNotFound { hash })
    }

    /// Estimate the costs of a message.
    pub async fn estimate_costs(
        &self,
        msg: Message,
    ) -> ChainResult<hyperlane_core::TxCostEstimate> {
        let tx = self.signer()?.read().await.deref().unsigned_transaction(
            NonEmpty::new_unchecked(vec![msg]),
            &self.connection_conf.chain_id,
        )?;
        let outcome = self.simulate(tx).await?;

        Ok(hyperlane_core::TxCostEstimate {
            gas_limit: ((outcome.gas_used as f64 * self.connection_conf.gas_scale) as u64
                + self.connection_conf.flat_gas_increase)
                .into(),
            gas_price: self.connection_conf.gas_price.amount.inner().into(),
            l2_gas_limit: None,
        })
    }

    /// Sign and broadcast a message.
    pub async fn send_message_and_find(
        &self,
        msg: Message,
        gas_limit: Option<u64>,
    ) -> ChainResult<hyperlane_core::TxOutcome> {
        let signer = self.signer()?;

        let nonce = self
            .query_wasm_smart(
                signer.read().await.address,
                spot::QuerySeenNoncesRequest {},
                None,
            )
            .await?
            .last()
            .map(|newest_nonce| newest_nonce + 1)
            .unwrap_or(0);

        signer.write().await.nonce = Defined::new(nonce);

        let gas = if let Some(gas_limit) = gas_limit {
            GasOption::Predefined { gas_limit }
        } else {
            GasOption::Simulate {
                scale: self.connection_conf.gas_scale,
                flat_increase: self.connection_conf.flat_gas_increase,
            }
        };

        let hash = self
            .send_message(
                signer.write().await.deref_mut(),
                msg,
                gas,
                &self.connection_conf.chain_id,
            )
            .await?
            .tx_hash;

        tokio::time::sleep(self.connection_conf.post_broadcast_sleep).await;

        let outcome = self.search_tx_loop(hash).await?;

        Ok(hyperlane_core::TxOutcome {
            transaction_id: outcome.hash.convert(),
            executed: outcome.outcome.result.is_ok(),
            gas_used: outcome.outcome.gas_used.into(),
            gas_price: self.connection_conf.gas_price.amount.inner().into(),
        })
    }

    // Utility

    /// Validate the reorg period.
    pub async fn validate_reorg_period(&self, reorg_period: &ReorgPeriod) -> ChainResult<()> {
        // Currently we support only None reorg period

        if let ReorgPeriod::None = reorg_period {
            return Ok(());
        } else {
            return Err(DangoError::InvalidReorgPeriod(reorg_period.clone()).into());
        }

        // let block_height = match reorg_period {
        //     ReorgPeriod::Blocks(blocks) => {
        //         let last_block = self.latest_block().await?;
        //         let block_height = last_block.checked_sub(blocks.get() as u64).ok_or(
        //             DangoError::ReorgPeriodTooLarge {
        //                 current_block_height: last_block,
        //                 reorg_period: blocks.get() as u64,
        //             },
        //         )?;
        //         Some(block_height)
        //     }
        //     ReorgPeriod::None => None,
        //     ReorgPeriod::Tag(_) => {
        //         return Err(anyhow::anyhow!(
        //             "Tag reorg period is not supported in Dango MerkleTreeHook"
        //         )
        //         .into())
        //     }
        // };
    }

    /// Get the latest block number
    pub async fn latest_block(&self) -> ChainResult<u64> {
        self.query_status(None)
            .await
            .map(|res| res.last_finalized_block.height)
    }

    pub async fn query_wasm_smart_with_height<R>(
        &self,
        contract: Addr,
        req: R,
    ) -> ChainResult<(R::Response, u64)>
    where
        R: QueryRequest + Send,
        R::Message: Serialize + Send,
        R::Response: DeserializeOwned,
    {
        let msg = R::Message::from(req);

        let [wasm_smart_response, status_response] = self
            .query_multi([Query::wasm_smart(contract, &msg)?, Query::status()], None)
            .await?;

        Ok((
            wasm_smart_response?.as_wasm_smart().deserialize_json()?,
            status_response?.as_status().last_finalized_block.height,
        ))
    }
}

impl std::fmt::Debug for DangoProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "domain: {:?}", self.domain)?;
        write!(f, "connection_conf: {:?}", self.connection_conf)?;
        write!(f, "signer: {:?}", self.signer)?;
        Ok(())
    }
}

impl HyperlaneChain for DangoProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for DangoProvider {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block = self.query_block(Some(height)).await?;

        Ok(BlockInfo {
            hash: block.info.hash.convert(),
            timestamp: block.info.timestamp.into_seconds() as u64,
            number: block.info.height,
        })
    }

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let tx = self.search_tx(hash.try_convert()?).await?;

        let data: Metadata = tx.tx.data.clone().deserialize_json()?;

        let recipient = tx.tx.msgs.iter().fold(None, |mut acc, msg| {
            // If the tx contains multiple messages, we can't return a list of contracts,
            // so just return the last one.
            // We parse only Execute messages, because we are interested in the contract interacted with.
            if let Message::Execute(MsgExecute { contract, .. }) = msg {
                acc = Some(DangoConvertor::<H256>::convert(*contract));
            }

            acc
        });

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: tx.outcome.gas_limit.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            // This seems to be the gas used, not the gas price
            gas_price: Some(tx.outcome.gas_used.into()),
            nonce: data.nonce.into(),
            sender: tx.tx.sender.convert(),
            recipient,
            receipt: None,
            raw_input_data: Some(tx.tx.to_json_vec()?),
        })
    }

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        match self.query_contract(address.try_convert()?, None).await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let address = Addr::from_str(&address)?;

        let balance = self
            .query_balance(address, self.connection_conf.gas_price.denom.clone(), None)
            .await?;

        Ok(balance.into_inner().into())
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let block = self.query_block(None).await?;
        return Ok(Some(ChainInfo {
            latest_block: BlockInfo {
                hash: block.info.hash.convert(),
                timestamp: block.info.timestamp.into_seconds() as u64,
                number: block.info.height,
            },
            min_gas_price: None,
        }));
    }
}

#[async_trait]
impl BlockNumberGetter for DangoProvider {
    async fn get_block_number(&self) -> ChainResult<u64> {
        todo!()
    }
}

#[async_trait]
impl QueryClient for DangoProvider {
    type Error = ChainCommunicationError;
    type Proof = grug::Proof;

    async fn query_app(
        &self,
        query: Query,
        height: Option<u64>,
    ) -> Result<QueryResponse, Self::Error> {
        self.client
            .call(|client| {
                let query = query.clone();
                let future = async move { Ok(client.query_app(query, height).await?) };
                Box::pin(future)
            })
            .await
    }

    async fn query_store(
        &self,
        key: Binary,
        height: Option<u64>,
        prove: bool,
    ) -> Result<(Option<Binary>, Option<Self::Proof>), Self::Error> {
        self.client
            .call(|client| {
                let key = key.clone();
                let future = async move { Ok(client.query_store(key, height, prove).await?) };
                Box::pin(future)
            })
            .await
    }

    async fn simulate(&self, tx: UnsignedTx) -> Result<TxOutcome, Self::Error> {
        self.client
            .call(|client| {
                let tx = tx.clone();
                let future = async move { Ok(client.simulate(tx).await?) };
                Box::pin(future)
            })
            .await
    }
}

#[async_trait]
impl BlockClient for DangoProvider {
    type Error = ChainCommunicationError;

    async fn query_block(&self, height: Option<u64>) -> Result<Block, Self::Error> {
        self.client
            .call(|client| {
                let future = async move { Ok(client.query_block(height).await?) };
                Box::pin(future)
            })
            .await
    }

    async fn query_block_outcome(&self, height: Option<u64>) -> Result<BlockOutcome, Self::Error> {
        self.client
            .call(|client| {
                let future = async move { Ok(client.query_block_outcome(height).await?) };
                Box::pin(future)
            })
            .await
    }
}

#[async_trait]
impl SearchTxClient for DangoProvider {
    type Error = ChainCommunicationError;

    async fn search_tx(&self, hash: Hash256) -> Result<SearchTxOutcome, Self::Error> {
        self.client
            .call(|client| {
                let future = async move {
                    match client.search_tx(hash).await {
                        Ok(outcome) => {
                            info!("transaction found: {}", hash);
                            Ok(outcome)
                        }
                        Err(e) => {
                            info!("transaction not found: {}", hash);
                            Err(e.into())
                        }
                    }
                };
                Box::pin(future)
            })
            .await
    }
}

#[async_trait]
impl BroadcastClient for DangoProvider {
    type Error = ChainCommunicationError;

    async fn broadcast_tx(&self, tx: Tx) -> Result<BroadcastTxOutcome, Self::Error> {
        self.client
            .call(|client| {
                let tx = tx.clone();
                let future = async move { Ok(client.broadcast_tx(tx).await?) };
                Box::pin(future)
            })
            .await
    }
}
