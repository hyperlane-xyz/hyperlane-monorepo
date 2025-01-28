#[derive(Debug)]
pub struct InterchainSecurityModule<A: starknet::accounts::ConnectedAccount + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub account: A,
    pub block_id: starknet::core::types::BlockId,
}
impl<A: starknet::accounts::ConnectedAccount + Sync> InterchainSecurityModule<A> {
    pub fn new(address: starknet::core::types::FieldElement, account: A) -> Self {
        Self {
            address,
            account,
            block_id: starknet::core::types::BlockId::Tag(starknet::core::types::BlockTag::Pending),
        }
    }
    pub fn set_contract_address(mut self, address: starknet::core::types::FieldElement) {
        self.address = address;
    }
    pub fn provider(&self) -> &A::Provider {
        self.account.provider()
    }
    pub fn set_block(mut self, block_id: starknet::core::types::BlockId) {
        self.block_id = block_id;
    }
}
#[derive(Debug)]
pub struct InterchainSecurityModuleReader<P: starknet::providers::Provider + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub provider: P,
    pub block_id: starknet::core::types::BlockId,
}
impl<P: starknet::providers::Provider + Sync> InterchainSecurityModuleReader<P> {
    pub fn new(address: starknet::core::types::FieldElement, provider: P) -> Self {
        Self {
            address,
            provider,
            block_id: starknet::core::types::BlockId::Tag(starknet::core::types::BlockTag::Pending),
        }
    }
    pub fn set_contract_address(mut self, address: starknet::core::types::FieldElement) {
        self.address = address;
    }
    pub fn provider(&self) -> &P {
        &self.provider
    }
    pub fn set_block(mut self, block_id: starknet::core::types::BlockId) {
        self.block_id = block_id;
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Message {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: cainome::cairo_serde::U256,
    pub destination: u32,
    pub recipient: cainome::cairo_serde::U256,
    pub body: Bytes,
}
impl cainome::cairo_serde::CairoSerde for Message {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += u8::cairo_serialized_size(&__rust.version);
        __size += u32::cairo_serialized_size(&__rust.nonce);
        __size += u32::cairo_serialized_size(&__rust.origin);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.sender);
        __size += u32::cairo_serialized_size(&__rust.destination);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.recipient);
        __size += Bytes::cairo_serialized_size(&__rust.body);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(u8::cairo_serialize(&__rust.version));
        __out.extend(u32::cairo_serialize(&__rust.nonce));
        __out.extend(u32::cairo_serialize(&__rust.origin));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.sender));
        __out.extend(u32::cairo_serialize(&__rust.destination));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(
            &__rust.recipient,
        ));
        __out.extend(Bytes::cairo_serialize(&__rust.body));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let version = u8::cairo_deserialize(__felts, __offset)?;
        __offset += u8::cairo_serialized_size(&version);
        let nonce = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&nonce);
        let origin = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&origin);
        let sender = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&sender);
        let destination = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&destination);
        let recipient = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&recipient);
        let body = Bytes::cairo_deserialize(__felts, __offset)?;
        __offset += Bytes::cairo_serialized_size(&body);
        Ok(Message {
            version,
            nonce,
            origin,
            sender,
            destination,
            recipient,
            body,
        })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Bytes {
    pub size: u32,
    pub data: Vec<u128>,
}
impl cainome::cairo_serde::CairoSerde for Bytes {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += u32::cairo_serialized_size(&__rust.size);
        __size += Vec::<u128>::cairo_serialized_size(&__rust.data);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(u32::cairo_serialize(&__rust.size));
        __out.extend(Vec::<u128>::cairo_serialize(&__rust.data));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let size = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&size);
        let data = Vec::<u128>::cairo_deserialize(__felts, __offset)?;
        __offset += Vec::<u128>::cairo_serialized_size(&data);
        Ok(Bytes { size, data })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum Event {}
impl cainome::cairo_serde::CairoSerde for Event {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            _ => 0,
        }
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            _ => vec![],
        }
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let __index: u128 = __felts[__offset].try_into().unwrap();
        match __index as usize {
            _ => {
                return Err(cainome::cairo_serde::Error::Deserialize(format!(
                    "Index not handle for enum {}",
                    "Event"
                )));
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for Event {
    type Error = String;
    fn try_from(event: starknet::core::types::EmittedEvent) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        Err(format!(
            "Could not match any event from keys {:?}",
            event.keys
        ))
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum ModuleType {
    UNUSED(cainome::cairo_serde::ContractAddress),
    ROUTING(cainome::cairo_serde::ContractAddress),
    AGGREGATION(cainome::cairo_serde::ContractAddress),
    LEGACY_MULTISIG(cainome::cairo_serde::ContractAddress),
    MERKLE_ROOT_MULTISIG(cainome::cairo_serde::ContractAddress),
    MESSAGE_ID_MULTISIG(cainome::cairo_serde::ContractAddress),
    NULL,
    CCIP_READ(cainome::cairo_serde::ContractAddress),
}
impl cainome::cairo_serde::CairoSerde for ModuleType {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            ModuleType::UNUSED(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::ROUTING(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::AGGREGATION(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::LEGACY_MULTISIG(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::MERKLE_ROOT_MULTISIG(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::MESSAGE_ID_MULTISIG(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            ModuleType::NULL => 1,
            ModuleType::CCIP_READ(val) => {
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(val) + 1
            }
            _ => 0,
        }
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            ModuleType::UNUSED(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&0usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::ROUTING(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&1usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::AGGREGATION(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&2usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::LEGACY_MULTISIG(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&3usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::MERKLE_ROOT_MULTISIG(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&4usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::MESSAGE_ID_MULTISIG(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&5usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            ModuleType::NULL => usize::cairo_serialize(&6usize),
            ModuleType::CCIP_READ(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&7usize));
                temp.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(val));
                temp
            }
            _ => vec![],
        }
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let __index: u128 = __felts[__offset].try_into().unwrap();
        match __index as usize {
            0usize => Ok(ModuleType::UNUSED(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            1usize => Ok(ModuleType::ROUTING(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            2usize => Ok(ModuleType::AGGREGATION(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            3usize => Ok(ModuleType::LEGACY_MULTISIG(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            4usize => Ok(ModuleType::MERKLE_ROOT_MULTISIG(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            5usize => Ok(ModuleType::MESSAGE_ID_MULTISIG(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            6usize => Ok(ModuleType::NULL),
            7usize => Ok(ModuleType::CCIP_READ(
                cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset + 1)?,
            )),
            _ => {
                return Err(cainome::cairo_serde::Error::Deserialize(format!(
                    "Index not handle for enum {}",
                    "ModuleType"
                )));
            }
        }
    }
}
impl<A: starknet::accounts::ConnectedAccount + Sync> InterchainSecurityModule<A> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn module_type(&self) -> cainome::cairo_serde::call::FCall<A::Provider, ModuleType> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("module_type"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &self,
        _metadata: &Bytes,
        _message: &Message,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("verify"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
}
impl<P: starknet::providers::Provider + Sync> InterchainSecurityModuleReader<P> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn module_type(&self) -> cainome::cairo_serde::call::FCall<P, ModuleType> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("module_type"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &self,
        _metadata: &Bytes,
        _message: &Message,
    ) -> cainome::cairo_serde::call::FCall<P, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("verify"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
}
