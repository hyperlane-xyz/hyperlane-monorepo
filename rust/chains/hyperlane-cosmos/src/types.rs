use hyperlane_core::ModuleType;

pub struct IsmType(pub hpl_interface::ism::ISMType);

impl From<hpl_interface::ism::ISMType> for IsmType {
    fn from(value: hpl_interface::ism::ISMType) -> Self {
        IsmType(value)
    }
}

impl From<IsmType> for ModuleType {
    fn from(value: IsmType) -> Self {
        match value.0 {
            hpl_interface::ism::ISMType::Unused => ModuleType::Unused,
            hpl_interface::ism::ISMType::Routing => ModuleType::Routing,
            hpl_interface::ism::ISMType::Aggregation => ModuleType::Aggregation,
            hpl_interface::ism::ISMType::LegacyMultisig => ModuleType::MessageIdMultisig,
            hpl_interface::ism::ISMType::MerkleRootMultisig => ModuleType::MerkleRootMultisig,
            hpl_interface::ism::ISMType::MessageIdMultisig => ModuleType::MessageIdMultisig,
            hpl_interface::ism::ISMType::Null => ModuleType::Null,
            hpl_interface::ism::ISMType::CcipRead => ModuleType::CcipRead,
        }
    }
}
