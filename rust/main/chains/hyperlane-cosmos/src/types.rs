use cosmrs::proto::{cosmos::base::abci::v1beta1::TxResponse, tendermint::Error};
use hyperlane_core::{ChainResult, ModuleType, TxOutcome, H256, U256};
use url::Url;

pub struct IsmType(pub hyperlane_cosmwasm_interface::ism::IsmType);

impl From<hyperlane_cosmwasm_interface::ism::IsmType> for IsmType {
    fn from(value: hyperlane_cosmwasm_interface::ism::IsmType) -> Self {
        IsmType(value)
    }
}

impl From<IsmType> for ModuleType {
    fn from(value: IsmType) -> Self {
        match value.0 {
            hyperlane_cosmwasm_interface::ism::IsmType::Unused => ModuleType::Unused,
            hyperlane_cosmwasm_interface::ism::IsmType::Routing => ModuleType::Routing,
            hyperlane_cosmwasm_interface::ism::IsmType::Aggregation => ModuleType::Aggregation,
            hyperlane_cosmwasm_interface::ism::IsmType::LegacyMultisig => {
                ModuleType::MessageIdMultisig
            }
            hyperlane_cosmwasm_interface::ism::IsmType::MerkleRootMultisig => {
                ModuleType::MerkleRootMultisig
            }
            hyperlane_cosmwasm_interface::ism::IsmType::MessageIdMultisig => {
                ModuleType::MessageIdMultisig
            }
            hyperlane_cosmwasm_interface::ism::IsmType::Null => ModuleType::Null,
            hyperlane_cosmwasm_interface::ism::IsmType::CcipRead => ModuleType::CcipRead,
        }
    }
}

pub trait ToCosmosHttpUrl {
    fn to_cosmos_http_url(
        &self,
    ) -> Result<tendermint_rpc::HttpClientUrl, tendermint_rpc::error::Error>;
}

impl ToCosmosHttpUrl for url::Url {
    fn to_cosmos_http_url(
        &self,
    ) -> Result<tendermint_rpc::HttpClientUrl, tendermint_rpc::error::Error> {
        let tendermint_url = tendermint_rpc::Url::try_from(self.to_owned())?;
        tendermint_rpc::HttpClientUrl::try_from(tendermint_url)
    }
}

pub fn tx_response_to_outcome(response: TxResponse) -> ChainResult<TxOutcome> {
    Ok(TxOutcome {
        transaction_id: H256::from_slice(hex::decode(response.txhash)?.as_slice()).into(),
        executed: response.code == 0,
        gas_used: U256::from(response.gas_used),
        gas_price: U256::one().try_into()?,
    })
}
