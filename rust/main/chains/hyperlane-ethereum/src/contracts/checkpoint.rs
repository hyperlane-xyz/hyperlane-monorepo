use crate::{
    signer::Signers,
    tx::{fill_tx_gas_params, report_tx},
};
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider, TransactionOverrides};
use async_trait::async_trait;
use ethers::prelude::Middleware;
use ethers::prelude::SignerMiddleware;
use eyre::Result;
use hyperlane_core::OnchainCheckpointStorage;
use hyperlane_core::{ContractLocator, HyperlaneDomain, HyperlaneDomainProtocol};
use std::sync::Arc;
/* use crate::interfaces::i_checkpoint::{
    ICheckpoint as EthereumCheckpointStorageInternal, ProcessCall, ICHECKPOINT_ABI,
}; */

pub struct EthereumCheckpointStorageBuilder {}

#[async_trait]
impl BuildableWithProvider for EthereumCheckpointStorageBuilder {
    type Output = Box<dyn OnchainCheckpointStorage>;
    const NEEDS_SIGNER: bool = true;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        todo!()
        /* Box::new(EthereumCheckpointStorage::new(Arc::new(provider), conn, locator)) */
    }
}

#[derive(Debug)]
pub struct EthereumCheckpointStorage<M>
where
    M: Middleware,
{
    // contract: todo!(), // Arc<EthereumMailboxInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    conn: ConnectionConf,
}

impl<M> EthereumCheckpointStorage<M>
where
    M: Middleware,
{
    pub fn new(
        chain: HyperlaneDomainProtocol,
        contract_address: String,
        signer: Signers,
    ) -> Result<Self> {
        /* let ethereum_signer = signer.ethereum_signer().await?
        .ok_or_else(|| eyre::eyre!("Ethereum signer is required for EthereumStorage"))?;
        let provider = Arc::new(SignerMiddleware::new(
            chain.provider()?,
            ethereum_signer,
        ));
        Box::new(EthereumCheckpointStorage {
            provider,
            contract_address,
            transaction_overrides: TransactionOverrides::default(),
        }) */
        todo!()
    }
}

#[async_trait]
impl<M: Middleware + 'static> OnchainCheckpointStorage for EthereumCheckpointStorage<M> {
    // FIXME reference this CheckpointWithMessageId { checkpoint: Checkpoint { in mod.rs
    async fn write_to_contract(&self, key: &str, data: &[u8]) -> Result<()> {
        /* let function = "write".to_string();
        let params = ethers::abi::encode(&[
            ethers::abi::Token::String(key.to_string()),
            ethers::abi::Token::Bytes(data.to_vec()),
        ]);

        let call = self.provider.call(self.contract_address, params, None);

        let call_with_gas_overrides = fill_tx_gas_params(
            call,
            Arc::clone(&self.provider),
            &self.transaction_overrides
        ).await?;

        let outcome = report_tx(call_with_gas_overrides).await?;

        if !outcome.executed {
            return Err(eyre::eyre!("Transaction failed"));
        }

        Ok(()) */
        todo!()
    }

    async fn read_from_contract(&self, key: &str) -> Result<Option<Vec<u8>>> {
        /* let function = "read".to_string();
        let params = ethers::abi::encode(&[ethers::abi::Token::String(key.to_string())]);

        let result = self.provider.call(
            self.contract_address,
            params,
            None,
        ).await?;

        if result.is_empty() {
            Ok(None)
        } else {
            Ok(Some(result))
        } */
        todo!()
    }
}
