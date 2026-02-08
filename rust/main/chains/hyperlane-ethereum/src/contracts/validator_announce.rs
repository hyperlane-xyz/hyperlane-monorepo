#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use ethers::providers::Middleware;
use ethers_contract::builders::ContractCall;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use tracing::{instrument, trace};

use crate::{
    interfaces::i_validator_announce::{
        IValidatorAnnounce as EthereumValidatorAnnounceInternal, IVALIDATORANNOUNCE_ABI,
    },
    tx::{fill_tx_gas_params, report_tx},
    BuildableWithProvider, ConnectionConf, EthereumProvider,
};

impl<M> std::fmt::Display for EthereumValidatorAnnounceInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

pub struct ValidatorAnnounceBuilder {}

#[async_trait]
impl BuildableWithProvider for ValidatorAnnounceBuilder {
    type Output = Box<dyn ValidatorAnnounce>;
    const NEEDS_SIGNER: bool = true;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumValidatorAnnounce::new(
            Arc::new(provider),
            conn,
            locator,
        ))
    }
}

/// A reference to a ValidatorAnnounce contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumValidatorAnnounce<M>
where
    M: Middleware,
{
    contract: Arc<EthereumValidatorAnnounceInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    conn: ConnectionConf,
}

impl<M> EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a ValidatoAnnounce contract at a specific Ethereum
    /// address on some chain
    pub fn new(provider: Arc<M>, conn: &ConnectionConf, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumValidatorAnnounceInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
            conn: conn.clone(),
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<ContractCall<M, bool>> {
        let serialized_signature: [u8; 65] = announcement.signature.into();
        let tx = self.contract.announce(
            announcement.value.validator.into(),
            announcement.value.storage_location,
            serialized_signature.into(),
        );
        fill_tx_gas_params(
            tx,
            self.provider.clone(),
            &self.conn.transaction_overrides,
            &self.domain,
            true,
            // pass an empty value as the cache
            Default::default(),
        )
        .await
    }
}

impl<M> HyperlaneChain for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> ValidatorAnnounce for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let storage_locations = self
            .contract
            .get_announced_storage_locations(
                validators.iter().map(|v| H160::from(*v).into()).collect(),
            )
            .call()
            .await?;
        Ok(storage_locations)
    }

    #[instrument(ret, skip(self))]
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        chain_signer: H256,
    ) -> Option<U256> {
        let Ok(contract_call) = self.announce_contract_call(announcement).await else {
            trace!("Unable to get announce contract call");
            return None;
        };

        let chain_signer_h160 = ethers::types::H160::from(chain_signer);
        let Ok(balance) = self.provider.get_balance(chain_signer_h160, None).await else {
            trace!("Unable to query balance");
            return None;
        };

        let Some(max_cost) = contract_call.tx.max_cost() else {
            trace!("Unable to get announce max cost");
            return None;
        };
        Some(max_cost.saturating_sub(balance).into())
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let contract_call = self.announce_contract_call(announcement).await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    async fn announce_calldata(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<Vec<u8>> {
        let contract_call = self.announce_contract_call(announcement).await?;
        let data = (contract_call.tx, contract_call.function);
        serde_json::to_vec(&data).map_err(Into::into)
    }
}

pub struct EthereumValidatorAnnounceAbi;

impl HyperlaneAbi for EthereumValidatorAnnounceAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IVALIDATORANNOUNCE_ABI)
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;

    use ethers::{
        providers::{MockProvider, Provider},
        types::{Block, Transaction, U256 as EthersU256},
    };
    use ethers_core::types::FeeHistory;
    use hyperlane_core::{
        Announcement, ContractLocator, HyperlaneDomain, HyperlaneSignerExt, KnownHyperlaneDomain,
        SignedType, ValidatorAnnounce, H256, U256,
    };

    use crate::{contracts::EthereumValidatorAnnounce, ConnectionConf, RpcConnectionConf, Signers};

    fn get_test_validator_announce(
        domain: HyperlaneDomain,
    ) -> (
        EthereumValidatorAnnounce<Provider<Arc<MockProvider>>>,
        Arc<MockProvider>,
    ) {
        let mock_provider = Arc::new(MockProvider::new());
        let provider = Arc::new(Provider::new(mock_provider.clone()));
        let connection_conf = ConnectionConf {
            rpc_connection: RpcConnectionConf::Http {
                url: "http://127.0.0.1:8545".parse().unwrap(),
            },
            transaction_overrides: Default::default(),
            op_submission_config: Default::default(),
            consider_null_transaction_receipt: false,
        };

        let validator_announce = EthereumValidatorAnnounce::new(
            provider.clone(),
            &connection_conf,
            &ContractLocator {
                domain: &domain,
                address: H256::default(),
            },
        );
        (validator_announce, mock_provider)
    }

    async fn create_test_signed_announcement() -> SignedType<Announcement> {
        let announcement = Announcement {
            validator: H256::from_low_u64_be(1).into(),
            mailbox_address: H256::from_low_u64_be(2),
            mailbox_domain: 1,
            storage_location: "s3://test-bucket/validator".to_string(),
        };

        // Create a test signer using LocalWallet
        let signer: Signers = "1111111111111111111111111111111111111111111111111111111111111111"
            .parse::<ethers::signers::LocalWallet>()
            .unwrap()
            .into();

        signer.sign(announcement).await.unwrap()
    }

    /// Setup mock provider responses for gas estimation (LIFO order)
    fn setup_gas_estimation_mocks(mock_provider: &MockProvider) {
        let gas_price: U256 =
            EthersU256::from(ethers::utils::parse_units("15", "gwei").unwrap()).into();
        mock_provider.push(gas_price).unwrap();

        let fee_history = FeeHistory {
            oldest_block: ethers::types::U256::zero(),
            base_fee_per_gas: vec![],
            gas_used_ratio: vec![],
            reward: vec![vec![]],
        };
        mock_provider.push(fee_history.clone()).unwrap();
        mock_provider.push(fee_history.clone()).unwrap();
        mock_provider.push(fee_history).unwrap();

        let latest_block: Block<Transaction> = Block {
            gas_limit: ethers::types::U256::MAX,
            ..Block::<Transaction>::default()
        };
        mock_provider.push(latest_block).unwrap();

        let gas_limit = U256::from(100000u32);
        mock_provider.push(gas_limit).unwrap();
    }

    #[tokio::test]
    async fn test_announce_calldata_returns_valid_json_tuple() {
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let (validator_announce, mock_provider) = get_test_validator_announce(domain);
        let signed_announcement = create_test_signed_announcement().await;
        setup_gas_estimation_mocks(&mock_provider);

        let calldata = validator_announce
            .announce_calldata(signed_announcement)
            .await
            .unwrap();

        // Verify calldata is valid JSON tuple of (TypedTransaction, Function)
        assert!(!calldata.is_empty());
        let parsed: serde_json::Value = serde_json::from_slice(&calldata).unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        // Verify the function name is "announce"
        assert_eq!(parsed[1]["name"], "announce");
    }
}
