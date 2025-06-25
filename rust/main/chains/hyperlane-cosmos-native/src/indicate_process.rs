use cosmrs::Any;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::MsgIndicateProgress;
use hyperlane_cosmos_rs::prost::{Message, Name};

use hyperlane_core::{
    ChainResult, ContractLocator, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, TxOutcome, H256,
};

use crate::CosmosNativeProvider;

/// A reference to a KAS indicate process contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosNativeIndicateProcess {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosNativeProvider,
}

impl CosmosNativeIndicateProcess {
    /// create a new instance of CosmosNativeIndicateProcess
    pub fn new(provider: CosmosNativeProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }

    /// Indicate that a withdrawal has been processed on Kaspa
    pub async fn indicate_process(&self, req: MsgIndicateProgress) -> ChainResult<TxOutcome> {
        let any_msg = Any {
            type_url: MsgIndicateProgress::type_url(),
            value: req.encode_to_vec(),
        };

        let response = self.provider.rpc().send(vec![any_msg], None).await?;

        // we assume that the underlying cosmos chain does not have gas refunds
        // in that case the gas paid will always be:
        // gas_wanted * gas_price
        let gas_price =
            FixedPointNumber::from(response.tx_result.gas_wanted) * self.provider.rpc().gas_price();

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: response.check_tx.code.is_ok() && response.tx_result.code.is_ok(),
            gas_used: response.tx_result.gas_used.into(),
            gas_price,
        })
    }
}

impl HyperlaneContract for CosmosNativeIndicateProcess {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosNativeIndicateProcess {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}
