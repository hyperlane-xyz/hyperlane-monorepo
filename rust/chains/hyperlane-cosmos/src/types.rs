use hyperlane_core::ModuleType;

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
