use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use hyperlane_core::{ChainResult, ModuleType, TxOutcome, H256, U256};

pub struct IsmType(pub hpl_interface::ism::IsmType);

impl From<hpl_interface::ism::IsmType> for IsmType {
    fn from(value: hpl_interface::ism::IsmType) -> Self {
        IsmType(value)
    }
}

impl From<IsmType> for ModuleType {
    fn from(value: IsmType) -> Self {
        match value.0 {
            hpl_interface::ism::IsmType::Unused => ModuleType::Unused,
            hpl_interface::ism::IsmType::Routing => ModuleType::Routing,
            hpl_interface::ism::IsmType::Aggregation => ModuleType::Aggregation,
            hpl_interface::ism::IsmType::LegacyMultisig => ModuleType::MessageIdMultisig,
            hpl_interface::ism::IsmType::MerkleRootMultisig => ModuleType::MerkleRootMultisig,
            hpl_interface::ism::IsmType::MessageIdMultisig => ModuleType::MessageIdMultisig,
            hpl_interface::ism::IsmType::Null => ModuleType::Null,
            hpl_interface::ism::IsmType::CcipRead => ModuleType::CcipRead,
        }
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
