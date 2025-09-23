use std::ops::Mul;

use cosmrs::Any;
use hex::ToHex;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    RawHyperlaneMessage, ReorgPeriod, TxCostEstimate, TxOutcome, H256, H512, U256,
};
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{MsgIndicateProgress, ProgressIndication};
use hyperlane_cosmos_rs::hyperlane::core::v1::MsgProcessMessage;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tonic::async_trait;
use tracing::info;

use crate::{utils, CosmosProvider};

use super::module_query_client::ModuleQueryClient;

/// Cosmos Native Mailbox
#[derive(Debug, Clone)]
pub struct CosmosNativeMailbox {
    /// CosmosNativeProvider (public for Kaspa bridge usage)
    pub provider: CosmosProvider<ModuleQueryClient>,
    domain: HyperlaneDomain,
    address: H256,
}

impl CosmosNativeMailbox {
    /// new cosmos native mailbox instance
    pub fn new(
        provider: CosmosProvider<ModuleQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<CosmosNativeMailbox> {
        Ok(CosmosNativeMailbox {
            provider,
            address: locator.address,
            domain: locator.domain.clone(),
        })
    }

    fn encode_hyperlane_message(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Any> {
        let mailbox_id: String = self.address.encode_hex();
        let message = hex::encode(RawHyperlaneMessage::from(message));
        let metadata = hex::encode(metadata);
        let signer = self.provider.rpc().get_signer()?.address_string.clone();
        let process = MsgProcessMessage {
            mailbox_id: format!("0x{mailbox_id}"),
            metadata,
            message,
            relayer: signer,
        };
        Ok(Any {
            type_url: MsgProcessMessage::type_url(),
            value: process.encode_to_vec(),
        })
    }

    /// A provider for the chain (keeping this method for compatibility)
    pub fn provider(&self) -> CosmosProvider<ModuleQueryClient> {
        self.provider.clone()
    }
}

impl HyperlaneChain for CosmosNativeMailbox {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for CosmosNativeMailbox {
    /// Return the original address
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Mailbox for CosmosNativeMailbox {
    /// Return the ISM address
    async fn default_ism(&self) -> ChainResult<H256> {
        let data = self
            .provider
            .query_client()
            .mailbox(self.address.encode_hex(), None)
            .await?
            .mailbox;

        let res = data
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("mailbox does not have default ISM")
            })?
            .default_ism
            .parse()?;

        Ok(res)
    }

    /// Return the recipient ISM of a given recipient
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let res = self
            .provider
            .query_client()
            .recipient_ism(recipient.encode_hex())
            .await?;

        if res.ism.is_empty() {
            return self.default_ism().await;
        }
        let res = res.ism.parse()?;

        Ok(res)
    }

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // we need the mailbox process transaction to be a single transaction and to be
        // blocking to ensure that the nonce is always monotonic increasing.
        // Hence the gas estimation and submission are done in the same call.
        let process_message = self.encode_hyperlane_message(message, metadata)?;

        let gas_limit = self
            .provider
            .rpc()
            .estimate_gas(vec![process_message.clone()])
            .await;

        let gas_limit = gas_limit
            .map_err(Into::<ChainCommunicationError>::into)?
            .base_fee
            .mul(U256::from_f64_lossy(
                utils::get_transmitter_gas_overide(&self.domain),
            ))
            .div_ceil(U256::one());

        let response = self
            .provider
            .rpc()
            .send(vec![process_message], Some(gas_limit))
            .await?;

        let tx_id = H256::from_slice(response.hash.as_bytes());

        // we assume that the underlying cosmos chain does not have gas refunds
        // in that case the gas paid will always be:
        // gas_wanted * gas_price
        // Cosmos does not charge a fee on failed transactions (before the ante handler).
        let gas_price = if response.tx_result.code.is_err() {
            FixedPointNumber::from(U256::zero())
        } else {
            FixedPointNumber::from(response.tx_result.gas_wanted)
                .mul(&self.provider.rpc().gas_price())
        };

        Ok(TxOutcome {
            transaction_id: tx_id.into(),
            executed: response.tx_result.code.is_ok() && response.check_tx.code.is_ok(),
            gas_used: response.tx_result.gas_used.into(),
            gas_price,
        })
    }

    /// Process a message with a proof against the provided signed checkpoint
    /// submitting the transaction and returning the tx outcome
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let gas_limit = self
            .provider
            .rpc()
            .estimate_gas(vec![self.encode_hyperlane_message(message, metadata)?])
            .await?;
        Ok(TxCostEstimate {
            // TODO: we are expecting this gas limit to be multiplied by the gas price but then again,
            // TODO: we are dividing by the gas price in `process` to get the gas limit.
            gas_limit: gas_limit.base_fee,
            gas_price: self.provider.rpc().gas_price(),
        })
    }

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        todo!() // we dont need this for now
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}

/// DYMENSION: required for Kaspa bridge, a special indicate progress TX
/// https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L29
impl CosmosNativeMailbox {
    /// atomically update the hub with a new outpoint anchor and set of completed withdrawals
    pub async fn indicate_progress(
        &self,
        metadata: &[u8],
        u: &ProgressIndication,
    ) -> ChainResult<TxOutcome> {
        let msg = MsgIndicateProgress {
            signer: self.provider.rpc().get_signer()?.address_string.clone(),
            metadata: metadata.to_vec(),
            payload: Some(u.clone()),
        };
        let a = Any {
            type_url: MsgIndicateProgress::type_url(),
            value: msg.encode_to_vec(),
        };
        let gas_limit = None;
        let response = self.provider.rpc().send(vec![a], gas_limit).await?;

        // we assume that the underlying cosmos chain does not have gas refunds
        // in that case the gas paid will always be:
        // gas_wanted * gas_price
        let gas_price = if response.tx_result.code.is_err() {
            FixedPointNumber::from(U256::zero())
        } else {
            FixedPointNumber::from(response.tx_result.gas_wanted)
                .mul(&self.provider.rpc().gas_price())
        };

        let executed = response.tx_result.code.is_ok() && response.check_tx.code.is_ok();

        // Logging here is a hack to get a reject reason.
        // TxOutcome doesn't have a field for the reject reason.
        // Cosmos doesn't save rejected TXs on-chain.
        // Logging here is the easiest way to see what happened.
        if !executed {
            info!("Dymension, indicate progress is not executed on-chain: {response:?}");
        }

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed,
            gas_used: response.tx_result.gas_used.into(),
            gas_price,
        })
    }
}

/// Convert H512 to Cosmos hash format (used by Kaspa bridge)
pub fn h512_to_cosmos_hash(h: H512) -> Hash {
    let h_256: H256 = h.into();
    Hash::from_bytes(Algorithm::Sha256, h_256.as_bytes()).unwrap()
}

#[cfg(test)]
mod test {
    use super::*;
    use tendermint::{hash::Algorithm, Hash};

    #[test]
    fn test_hash() {
        // From cosmos hex to HL transaction ID
        let cosmos_hex = "5F3C6367A3AAC0B7E0B1F63CE25FEEDA3914F57FA9EAEC0F6A10CD84740BA010";
        let cosmos_hash = Hash::from_hex_upper(Algorithm::Sha256, cosmos_hex).unwrap();
        let cosmos_bytes = cosmos_hash.as_bytes();

        let tx_id: H512 = H256::from_slice(cosmos_bytes).into();

        // From HL transaction ID to cosmos hex
        let tx_id_256: H256 = tx_id.into();
        let cosmos_bytes_1 = tx_id_256.as_bytes();
        let cosmos_hash_1 = Hash::from_bytes(Algorithm::Sha256, cosmos_bytes_1).unwrap();
        let cosmos_hex_1 = cosmos_hash_1.encode_hex_upper::<String>();

        assert_eq!(cosmos_hex, cosmos_hex_1.as_str());
    }
}