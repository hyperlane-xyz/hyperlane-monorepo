use hyperlane_core::ModuleType;

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
