#[derive(Debug)]
pub struct MerkleTreeHook<A: starknet::accounts::ConnectedAccount + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub account: A,
    pub block_id: starknet::core::types::BlockId,
}
impl<A: starknet::accounts::ConnectedAccount + Sync> MerkleTreeHook<A> {
    pub fn new(address: starknet::core::types::FieldElement, account: A) -> Self {
        Self {
            address,
            account,
            block_id: starknet::core::types::BlockId::Tag(
                starknet::core::types::BlockTag::Pending,
            ),
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
pub struct MerkleTreeHookReader<P: starknet::providers::Provider + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub provider: P,
    pub block_id: starknet::core::types::BlockId,
}
impl<P: starknet::providers::Provider + Sync> MerkleTreeHookReader<P> {
    pub fn new(address: starknet::core::types::FieldElement, provider: P) -> Self {
        Self {
            address,
            provider,
            block_id: starknet::core::types::BlockId::Tag(
                starknet::core::types::BlockTag::Pending,
            ),
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
pub struct ByteData {
    pub value: cainome::cairo_serde::U256,
    pub size: u32,
}
impl cainome::cairo_serde::CairoSerde for ByteData {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.value);
        __size += u32::cairo_serialized_size(&__rust.size);
        __size
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.value));
        __out.extend(u32::cairo_serialize(&__rust.size));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let value = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&value);
        let size = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&size);
        Ok(ByteData { value, size })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Tree {
    pub branch: Vec<ByteData>,
    pub count: cainome::cairo_serde::U256,
}
impl cainome::cairo_serde::CairoSerde for Tree {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += Vec::<ByteData>::cairo_serialized_size(&__rust.branch);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.count);
        __size
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(Vec::<ByteData>::cairo_serialize(&__rust.branch));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.count));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let branch = Vec::<ByteData>::cairo_deserialize(__felts, __offset)?;
        __offset += Vec::<ByteData>::cairo_serialized_size(&branch);
        let count = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&count);
        Ok(Tree { branch, count })
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
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
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
pub struct OwnershipTransferred {
    pub previous_owner: cainome::cairo_serde::ContractAddress,
    pub new_owner: cainome::cairo_serde::ContractAddress,
}
impl cainome::cairo_serde::CairoSerde for OwnershipTransferred {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &__rust.previous_owner,
            );
        __size
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &__rust.new_owner,
            );
        __size
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out
            .extend(
                cainome::cairo_serde::ContractAddress::cairo_serialize(
                    &__rust.previous_owner,
                ),
            );
        __out
            .extend(
                cainome::cairo_serde::ContractAddress::cairo_serialize(&__rust.new_owner),
            );
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let previous_owner = cainome::cairo_serde::ContractAddress::cairo_deserialize(
            __felts,
            __offset,
        )?;
        __offset
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &previous_owner,
            );
        let new_owner = cainome::cairo_serde::ContractAddress::cairo_deserialize(
            __felts,
            __offset,
        )?;
        __offset
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
        Ok(OwnershipTransferred {
            previous_owner,
            new_owner,
        })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct OwnershipTransferStarted {
    pub previous_owner: cainome::cairo_serde::ContractAddress,
    pub new_owner: cainome::cairo_serde::ContractAddress,
}
impl cainome::cairo_serde::CairoSerde for OwnershipTransferStarted {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &__rust.previous_owner,
            );
        __size
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &__rust.new_owner,
            );
        __size
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out
            .extend(
                cainome::cairo_serde::ContractAddress::cairo_serialize(
                    &__rust.previous_owner,
                ),
            );
        __out
            .extend(
                cainome::cairo_serde::ContractAddress::cairo_serialize(&__rust.new_owner),
            );
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let previous_owner = cainome::cairo_serde::ContractAddress::cairo_deserialize(
            __felts,
            __offset,
        )?;
        __offset
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                &previous_owner,
            );
        let new_owner = cainome::cairo_serde::ContractAddress::cairo_deserialize(
            __felts,
            __offset,
        )?;
        __offset
            += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
        Ok(OwnershipTransferStarted {
            previous_owner,
            new_owner,
        })
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
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(u8::cairo_serialize(&__rust.version));
        __out.extend(u32::cairo_serialize(&__rust.nonce));
        __out.extend(u32::cairo_serialize(&__rust.origin));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.sender));
        __out.extend(u32::cairo_serialize(&__rust.destination));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.recipient));
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
        let recipient = cainome::cairo_serde::U256::cairo_deserialize(
            __felts,
            __offset,
        )?;
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
pub struct InsertedIntoTree {
    pub id: cainome::cairo_serde::U256,
    pub index: u32,
}
impl cainome::cairo_serde::CairoSerde for InsertedIntoTree {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.id);
        __size += u32::cairo_serialized_size(&__rust.index);
        __size
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.id));
        __out.extend(u32::cairo_serialize(&__rust.index));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let id = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
        let index = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&index);
        Ok(InsertedIntoTree { id, index })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum Event {
    InsertedIntoTree(InsertedIntoTree),
    OwnableEvent(OwnableCptEvent),
    MailboxclientEvent(MailboxclientCptEvent),
}
impl cainome::cairo_serde::CairoSerde for Event {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            Event::InsertedIntoTree(val) => {
                InsertedIntoTree::cairo_serialized_size(val) + 1
            }
            Event::OwnableEvent(val) => OwnableCptEvent::cairo_serialized_size(val) + 1,
            Event::MailboxclientEvent(val) => {
                MailboxclientCptEvent::cairo_serialized_size(val) + 1
            }
            _ => 0,
        }
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            Event::InsertedIntoTree(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&0usize));
                temp.extend(InsertedIntoTree::cairo_serialize(val));
                temp
            }
            Event::OwnableEvent(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&1usize));
                temp.extend(OwnableCptEvent::cairo_serialize(val));
                temp
            }
            Event::MailboxclientEvent(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&2usize));
                temp.extend(MailboxclientCptEvent::cairo_serialize(val));
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
            0usize => {
                Ok(
                    Event::InsertedIntoTree(
                        InsertedIntoTree::cairo_deserialize(__felts, __offset + 1)?,
                    ),
                )
            }
            1usize => {
                Ok(
                    Event::OwnableEvent(
                        OwnableCptEvent::cairo_deserialize(__felts, __offset + 1)?,
                    ),
                )
            }
            2usize => {
                Ok(
                    Event::MailboxclientEvent(
                        MailboxclientCptEvent::cairo_deserialize(__felts, __offset + 1)?,
                    ),
                )
            }
            _ => {
                return Err(
                    cainome::cairo_serde::Error::Deserialize(
                        format!("Index not handle for enum {}", "Event"),
                    ),
                );
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for Event {
    type Error = String;
    fn try_from(
        event: starknet::core::types::EmittedEvent,
    ) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("InsertedIntoTree")
                .unwrap_or_else(|_| {
                    panic!("Invalid selector for {}", "InsertedIntoTree")
                })
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let id = match cainome::cairo_serde::U256::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "id",
                            "InsertedIntoTree", e
                        ),
                    );
                }
            };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
            let index = match u32::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "index",
                            "InsertedIntoTree", e
                        ),
                    );
                }
            };
            data_offset += u32::cairo_serialized_size(&index);
            return Ok(Event::InsertedIntoTree(InsertedIntoTree { id, index }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferred")
                .unwrap_or_else(|_| {
                    panic!("Invalid selector for {}", "OwnershipTransferred")
                })
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "previous_owner", "OwnershipTransferred", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &previous_owner,
                );
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "new_owner",
                            "OwnershipTransferred", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &new_owner,
                );
            return Ok(
                Event::OwnableEvent(
                    OwnableCptEvent::OwnershipTransferred(OwnershipTransferred {
                        previous_owner,
                        new_owner,
                    }),
                ),
            );
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferStarted")
                .unwrap_or_else(|_| {
                    panic!("Invalid selector for {}", "OwnershipTransferStarted")
                })
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "previous_owner", "OwnershipTransferStarted", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &previous_owner,
                );
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "new_owner",
                            "OwnershipTransferStarted", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &new_owner,
                );
            return Ok(
                Event::OwnableEvent(
                    OwnableCptEvent::OwnershipTransferStarted(OwnershipTransferStarted {
                        previous_owner,
                        new_owner,
                    }),
                ),
            );
        }
        Err(format!("Could not match any event from keys {:?}", event.keys))
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum MailboxclientCptEvent {}
impl cainome::cairo_serde::CairoSerde for MailboxclientCptEvent {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            _ => 0,
        }
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
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
                return Err(
                    cainome::cairo_serde::Error::Deserialize(
                        format!("Index not handle for enum {}", "MailboxclientCptEvent"),
                    ),
                );
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for MailboxclientCptEvent {
    type Error = String;
    fn try_from(
        event: starknet::core::types::EmittedEvent,
    ) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        Err(format!("Could not match any event from keys {:?}", event.keys))
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum Types {
    UNUSED,
    ROUTING,
    AGGREGATION,
    MERKLE_TREE,
    INTERCHAIN_GAS_PAYMASTER,
    FALLBACK_ROUTING,
    ID_AUTH_ISM,
    PAUSABLE,
    PROTOCOL_FEE,
    LAYER_ZERO_V1,
    Rate_Limited_Hook,
}
impl cainome::cairo_serde::CairoSerde for Types {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            Types::UNUSED => 1,
            Types::ROUTING => 1,
            Types::AGGREGATION => 1,
            Types::MERKLE_TREE => 1,
            Types::INTERCHAIN_GAS_PAYMASTER => 1,
            Types::FALLBACK_ROUTING => 1,
            Types::ID_AUTH_ISM => 1,
            Types::PAUSABLE => 1,
            Types::PROTOCOL_FEE => 1,
            Types::LAYER_ZERO_V1 => 1,
            Types::Rate_Limited_Hook => 1,
            _ => 0,
        }
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            Types::UNUSED => usize::cairo_serialize(&0usize),
            Types::ROUTING => usize::cairo_serialize(&1usize),
            Types::AGGREGATION => usize::cairo_serialize(&2usize),
            Types::MERKLE_TREE => usize::cairo_serialize(&3usize),
            Types::INTERCHAIN_GAS_PAYMASTER => usize::cairo_serialize(&4usize),
            Types::FALLBACK_ROUTING => usize::cairo_serialize(&5usize),
            Types::ID_AUTH_ISM => usize::cairo_serialize(&6usize),
            Types::PAUSABLE => usize::cairo_serialize(&7usize),
            Types::PROTOCOL_FEE => usize::cairo_serialize(&8usize),
            Types::LAYER_ZERO_V1 => usize::cairo_serialize(&9usize),
            Types::Rate_Limited_Hook => usize::cairo_serialize(&10usize),
            _ => vec![],
        }
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let __index: u128 = __felts[__offset].try_into().unwrap();
        match __index as usize {
            0usize => Ok(Types::UNUSED),
            1usize => Ok(Types::ROUTING),
            2usize => Ok(Types::AGGREGATION),
            3usize => Ok(Types::MERKLE_TREE),
            4usize => Ok(Types::INTERCHAIN_GAS_PAYMASTER),
            5usize => Ok(Types::FALLBACK_ROUTING),
            6usize => Ok(Types::ID_AUTH_ISM),
            7usize => Ok(Types::PAUSABLE),
            8usize => Ok(Types::PROTOCOL_FEE),
            9usize => Ok(Types::LAYER_ZERO_V1),
            10usize => Ok(Types::Rate_Limited_Hook),
            _ => {
                return Err(
                    cainome::cairo_serde::Error::Deserialize(
                        format!("Index not handle for enum {}", "Types"),
                    ),
                );
            }
        }
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum OwnableCptEvent {
    OwnershipTransferred(OwnershipTransferred),
    OwnershipTransferStarted(OwnershipTransferStarted),
}
impl cainome::cairo_serde::CairoSerde for OwnableCptEvent {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            OwnableCptEvent::OwnershipTransferred(val) => {
                OwnershipTransferred::cairo_serialized_size(val) + 1
            }
            OwnableCptEvent::OwnershipTransferStarted(val) => {
                OwnershipTransferStarted::cairo_serialized_size(val) + 1
            }
            _ => 0,
        }
    }
    fn cairo_serialize(
        __rust: &Self::RustType,
    ) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            OwnableCptEvent::OwnershipTransferred(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&0usize));
                temp.extend(OwnershipTransferred::cairo_serialize(val));
                temp
            }
            OwnableCptEvent::OwnershipTransferStarted(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&1usize));
                temp.extend(OwnershipTransferStarted::cairo_serialize(val));
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
            0usize => {
                Ok(
                    OwnableCptEvent::OwnershipTransferred(
                        OwnershipTransferred::cairo_deserialize(__felts, __offset + 1)?,
                    ),
                )
            }
            1usize => {
                Ok(
                    OwnableCptEvent::OwnershipTransferStarted(
                        OwnershipTransferStarted::cairo_deserialize(
                            __felts,
                            __offset + 1,
                        )?,
                    ),
                )
            }
            _ => {
                return Err(
                    cainome::cairo_serde::Error::Deserialize(
                        format!("Index not handle for enum {}", "OwnableCptEvent"),
                    ),
                );
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for OwnableCptEvent {
    type Error = String;
    fn try_from(
        event: starknet::core::types::EmittedEvent,
    ) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferred")
                .unwrap_or_else(|_| {
                    panic!("Invalid selector for {}", "OwnershipTransferred")
                })
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "previous_owner", "OwnershipTransferred", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &previous_owner,
                );
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "new_owner",
                            "OwnershipTransferred", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &new_owner,
                );
            return Ok(
                OwnableCptEvent::OwnershipTransferred(OwnershipTransferred {
                    previous_owner,
                    new_owner,
                }),
            );
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferStarted")
                .unwrap_or_else(|_| {
                    panic!("Invalid selector for {}", "OwnershipTransferStarted")
                })
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "previous_owner", "OwnershipTransferStarted", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &previous_owner,
                );
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        format!(
                            "Could not deserialize field {} for {}: {:?}", "new_owner",
                            "OwnershipTransferStarted", e
                        ),
                    );
                }
            };
            key_offset
                += cainome::cairo_serde::ContractAddress::cairo_serialized_size(
                    &new_owner,
                );
            return Ok(
                OwnableCptEvent::OwnershipTransferStarted(OwnershipTransferStarted {
                    previous_owner,
                    new_owner,
                }),
            );
        }
        Err(format!("Could not match any event from keys {:?}", event.keys))
    }
}
impl<A: starknet::accounts::ConnectedAccount + Sync> MerkleTreeHook<A> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn owner(
        &self,
    ) -> cainome::cairo_serde::call::FCall<
        A::Provider,
        cainome::cairo_serde::ContractAddress,
    > {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("owner"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn hook_type(&self) -> cainome::cairo_serde::call::FCall<A::Provider, Types> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("hook_type"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn supports_metadata(
        &self,
        _metadata: &Bytes,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("supports_metadata"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn count(&self) -> cainome::cairo_serde::call::FCall<A::Provider, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("count"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn root(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("root"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn tree(&self) -> cainome::cairo_serde::call::FCall<A::Provider, Tree> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("tree"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn latest_checkpoint(
        &self,
    ) -> cainome::cairo_serde::call::FCall<
        A::Provider,
        (cainome::cairo_serde::U256, u32),
    > {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("latest_checkpoint"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_ownership_getcall(
        &self,
        new_owner: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata
            .extend(cainome::cairo_serde::ContractAddress::cairo_serialize(new_owner));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("transfer_ownership"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn transfer_ownership(
        &self,
        new_owner: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata
            .extend(cainome::cairo_serde::ContractAddress::cairo_serialize(new_owner));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("transfer_ownership"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn renounce_ownership_getcall(&self) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("renounce_ownership"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn renounce_ownership(&self) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("renounce_ownership"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn post_dispatch_getcall(
        &self,
        _metadata: &Bytes,
        _message: &Message,
        _fee_amount: &cainome::cairo_serde::U256,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_fee_amount));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("post_dispatch"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn post_dispatch(
        &self,
        _metadata: &Bytes,
        _message: &Message,
        _fee_amount: &cainome::cairo_serde::U256,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_fee_amount));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("post_dispatch"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn quote_dispatch_getcall(
        &self,
        _metadata: &Bytes,
        _message: &Message,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("quote_dispatch"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn quote_dispatch(
        &self,
        _metadata: &Bytes,
        _message: &Message,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        __calldata.extend(Message::cairo_serialize(_message));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("quote_dispatch"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
}
impl<P: starknet::providers::Provider + Sync> MerkleTreeHookReader<P> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn owner(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("owner"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn hook_type(&self) -> cainome::cairo_serde::call::FCall<P, Types> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("hook_type"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn supports_metadata(
        &self,
        _metadata: &Bytes,
    ) -> cainome::cairo_serde::call::FCall<P, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(Bytes::cairo_serialize(_metadata));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("supports_metadata"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn count(&self) -> cainome::cairo_serde::call::FCall<P, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("count"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn root(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("root"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn tree(&self) -> cainome::cairo_serde::call::FCall<P, Tree> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("tree"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn latest_checkpoint(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, (cainome::cairo_serde::U256, u32)> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("latest_checkpoint"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
}
