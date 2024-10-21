use crate::contracts::interchain_gas_paymaster::GasPaymentEvent;
use crate::{
    contracts::interchain_gas_paymaster::InterchainGasPaymaster as InterchainGasPaymasterContract,
    conversions::*, FuelProvider,
};
use crate::{ConnectionConf, FuelIndexer};
use async_trait::async_trait;
use fuels::accounts::wallet::WalletUnlocked;
use fuels::tx::Receipt;
use fuels::types::bech32::Bech32ContractId;
use fuels::types::transaction_response::TransactionResponse;
use fuels::types::tx_status::TxStatus;
use fuels::types::{Bits256, Bytes32};
use std::ops::RangeInclusive;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, Indexed, Indexer,
    InterchainGasPaymaster, SequenceAwareIndexer, U256,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};

/// A reference to an IGP contract on some Fuel chain
#[derive(Debug)]
pub struct FuelInterchainGasPaymaster {
    contract: InterchainGasPaymasterContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelInterchainGasPaymaster {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelInterchainGasPaymaster {
            contract: InterchainGasPaymasterContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl InterchainGasPaymaster for FuelInterchainGasPaymaster {}

// ----------------------------------------------------------
// ---------------------- Indexer ---------------------------
// ----------------------------------------------------------

const IGP_PAYMENT_LOG_LENGTH: usize = 48;

/// Struct that retrieves event data for a Fuel IGP contract
#[derive(Debug)]
pub struct FuelInterchainGasPaymasterIndexer {
    indexer: FuelIndexer,
}

impl FuelInterchainGasPaymasterIndexer {
    /// Create a new fuel IGP indexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let indexer = FuelIndexer::new::<GasPaymentEvent>(conf, locator, wallet).await;

        Ok(Self { indexer })
    }

    /// Parses igp payment transactions into the appropriate data to generate indexed logs
    pub fn igp_parser(
        transactions: Vec<(Bytes32, TransactionResponse)>,
    ) -> Vec<(Bytes32, TransactionResponse, InterchainGasPayment, U256)> {
        transactions
            .into_iter()
            .filter_map(|(tx_id, tx_data)| {
                let receipts = match &tx_data.status {
                    TxStatus::Success { receipts } => receipts,
                    _ => return None,
                };

                let (log_index, receipt_log_data) = receipts
                    .into_iter()
                    .enumerate()
                    .filter_map(|(log_index, rec)| match rec {
                        Receipt::LogData { .. }
                            if rec
                                .data()
                                .is_some_and(|data| data.len() == IGP_PAYMENT_LOG_LENGTH) =>
                        {
                            let data = rec.data().map(|data| data.to_owned());

                            match data {
                                Some(data) => Some((U256::from(log_index), data)),
                                _ => None,
                            }
                        }
                        _ => None,
                    })
                    .next()?; // Each dispatch call should have only one receipt with the appropriate length

                if !receipt_log_data.is_empty() {
                    let (message_id, destination_domain, gas_amount, payment) =
                        Self::decode_interchain_gas_payment(receipt_log_data).unwrap();

                    let igp_payment = InterchainGasPayment {
                        message_id: message_id.into_h256(),
                        gas_amount: U256::from(gas_amount),
                        payment: U256::from(payment),
                        destination: destination_domain,
                    };

                    Some((tx_id, tx_data, igp_payment, log_index))
                } else {
                    None
                }
            })
            .collect::<Vec<(Bytes32, TransactionResponse, InterchainGasPayment, U256)>>()
    }

    fn decode_interchain_gas_payment(data: Vec<u8>) -> Result<(Bits256, u32, u64, u64), String> {
        if data.len() != 52 {
            return Err("Invalid data length".to_owned());
        }

        // Extract message_id (first 32 bytes)
        let message_id_bytes: [u8; 32] = data[0..32]
            .try_into()
            .map_err(|_| "Failed to extract message_id")?;
        let message_id = Bits256(message_id_bytes);

        // Extract destination domain (next 4 bytes)
        let destination_domain_bytes: [u8; 4] = data[32..36]
            .try_into()
            .map_err(|_| "Failed to extract destination_domain")?;
        let destination_domain = u32::from_be_bytes(destination_domain_bytes);

        // Extract gas_amount (next 8 bytes)
        let gas_amount_bytes: [u8; 8] = data[32..40]
            .try_into()
            .map_err(|_| "Failed to extract gas_amount")?;
        let gas_amount = u64::from_be_bytes(gas_amount_bytes);

        // Extract payment (final 8 bytes)
        let payment_bytes: [u8; 8] = data[40..48]
            .try_into()
            .map_err(|_| "Failed to extract payment")?;
        let payment = u64::from_be_bytes(payment_bytes);

        Ok((message_id, destination_domain, gas_amount, payment))
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for FuelInterchainGasPaymasterIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        self.indexer
            .index_logs_in_range(range, Self::igp_parser)
            .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for FuelInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when fuel scraper support is implemented
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
