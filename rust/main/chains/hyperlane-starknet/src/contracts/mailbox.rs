#[derive(Debug)]
pub struct Mailbox<A: starknet::accounts::ConnectedAccount + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub account: A,
    pub block_id: starknet::core::types::BlockId,
}
impl<A: starknet::accounts::ConnectedAccount + Sync> Mailbox<A> {
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
pub struct MailboxReader<P: starknet::providers::Provider + Sync> {
    pub address: starknet::core::types::FieldElement,
    pub provider: P,
    pub block_id: starknet::core::types::BlockId,
}
impl<P: starknet::providers::Provider + Sync> MailboxReader<P> {
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
pub struct DefaultHookSet {
    pub hook: cainome::cairo_serde::ContractAddress,
}
impl cainome::cairo_serde::CairoSerde for DefaultHookSet {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.hook);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.hook,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let hook = cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&hook);
        Ok(DefaultHookSet { hook })
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
        __size +=
            cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.previous_owner);
        __size += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.new_owner);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.previous_owner,
        ));
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.new_owner,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let previous_owner =
            cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
        let new_owner =
            cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
        Ok(OwnershipTransferStarted {
            previous_owner,
            new_owner,
        })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Dispatch {
    pub sender: cainome::cairo_serde::U256,
    pub destination_domain: u32,
    pub recipient_address: cainome::cairo_serde::U256,
    pub message: Message,
}
impl cainome::cairo_serde::CairoSerde for Dispatch {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.sender);
        __size += u32::cairo_serialized_size(&__rust.destination_domain);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.recipient_address);
        __size += Message::cairo_serialized_size(&__rust.message);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.sender));
        __out.extend(u32::cairo_serialize(&__rust.destination_domain));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(
            &__rust.recipient_address,
        ));
        __out.extend(Message::cairo_serialize(&__rust.message));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let sender = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&sender);
        let destination_domain = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&destination_domain);
        let recipient_address = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&recipient_address);
        let message = Message::cairo_deserialize(__felts, __offset)?;
        __offset += Message::cairo_serialized_size(&message);
        Ok(Dispatch {
            sender,
            destination_domain,
            recipient_address,
            message,
        })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Upgraded {
    pub class_hash: cainome::cairo_serde::ClassHash,
}
impl cainome::cairo_serde::CairoSerde for Upgraded {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::ClassHash::cairo_serialized_size(&__rust.class_hash);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ClassHash::cairo_serialize(
            &__rust.class_hash,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let class_hash = cainome::cairo_serde::ClassHash::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ClassHash::cairo_serialized_size(&class_hash);
        Ok(Upgraded { class_hash })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct DispatchId {
    pub id: cainome::cairo_serde::U256,
}
impl cainome::cairo_serde::CairoSerde for DispatchId {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.id);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.id));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let id = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
        Ok(DispatchId { id })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct DefaultIsmSet {
    pub module: cainome::cairo_serde::ContractAddress,
}
impl cainome::cairo_serde::CairoSerde for DefaultIsmSet {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.module);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.module,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let module = cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&module);
        Ok(DefaultIsmSet { module })
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
        __size +=
            cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.previous_owner);
        __size += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.new_owner);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.previous_owner,
        ));
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.new_owner,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let previous_owner =
            cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
        let new_owner =
            cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
        Ok(OwnershipTransferred {
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
pub struct ProcessId {
    pub id: cainome::cairo_serde::U256,
}
impl cainome::cairo_serde::CairoSerde for ProcessId {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.id);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.id));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let id = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
        Ok(ProcessId { id })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct Process {
    pub origin: u32,
    pub sender: cainome::cairo_serde::U256,
    pub recipient: cainome::cairo_serde::U256,
}
impl cainome::cairo_serde::CairoSerde for Process {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += u32::cairo_serialized_size(&__rust.origin);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.sender);
        __size += cainome::cairo_serde::U256::cairo_serialized_size(&__rust.recipient);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(u32::cairo_serialize(&__rust.origin));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(&__rust.sender));
        __out.extend(cainome::cairo_serde::U256::cairo_serialize(
            &__rust.recipient,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let origin = u32::cairo_deserialize(__felts, __offset)?;
        __offset += u32::cairo_serialized_size(&origin);
        let sender = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&sender);
        let recipient = cainome::cairo_serde::U256::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::U256::cairo_serialized_size(&recipient);
        Ok(Process {
            origin,
            sender,
            recipient,
        })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub struct RequiredHookSet {
    pub hook: cainome::cairo_serde::ContractAddress,
}
impl cainome::cairo_serde::CairoSerde for RequiredHookSet {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        let mut __size = 0;
        __size += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&__rust.hook);
        __size
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        let mut __out: Vec<starknet::core::types::FieldElement> = vec![];
        __out.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            &__rust.hook,
        ));
        __out
    }
    fn cairo_deserialize(
        __felts: &[starknet::core::types::FieldElement],
        __offset: usize,
    ) -> cainome::cairo_serde::Result<Self::RustType> {
        let mut __offset = __offset;
        let hook = cainome::cairo_serde::ContractAddress::cairo_deserialize(__felts, __offset)?;
        __offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&hook);
        Ok(RequiredHookSet { hook })
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum UpgradeableCptEvent {
    Upgraded(Upgraded),
}
impl cainome::cairo_serde::CairoSerde for UpgradeableCptEvent {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            UpgradeableCptEvent::Upgraded(val) => Upgraded::cairo_serialized_size(val) + 1,
            _ => 0,
        }
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            UpgradeableCptEvent::Upgraded(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&0usize));
                temp.extend(Upgraded::cairo_serialize(val));
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
            0usize => Ok(UpgradeableCptEvent::Upgraded(Upgraded::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            _ => {
                return Err(cainome::cairo_serde::Error::Deserialize(format!(
                    "Index not handle for enum {}",
                    "UpgradeableCptEvent"
                )));
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for UpgradeableCptEvent {
    type Error = String;
    fn try_from(event: starknet::core::types::EmittedEvent) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("Upgraded")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "Upgraded"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let class_hash = match cainome::cairo_serde::ClassHash::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "class_hash", "Upgraded", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::ClassHash::cairo_serialized_size(&class_hash);
            return Ok(UpgradeableCptEvent::Upgraded(Upgraded { class_hash }));
        }
        Err(format!(
            "Could not match any event from keys {:?}",
            event.keys
        ))
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
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
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
            0usize => Ok(OwnableCptEvent::OwnershipTransferred(
                OwnershipTransferred::cairo_deserialize(__felts, __offset + 1)?,
            )),
            1usize => Ok(OwnableCptEvent::OwnershipTransferStarted(
                OwnershipTransferStarted::cairo_deserialize(__felts, __offset + 1)?,
            )),
            _ => {
                return Err(cainome::cairo_serde::Error::Deserialize(format!(
                    "Index not handle for enum {}",
                    "OwnableCptEvent"
                )));
            }
        }
    }
}
impl TryFrom<starknet::core::types::EmittedEvent> for OwnableCptEvent {
    type Error = String;
    fn try_from(event: starknet::core::types::EmittedEvent) -> Result<Self, Self::Error> {
        use cainome::cairo_serde::CairoSerde;
        if event.keys.is_empty() {
            return Err("Event has no key".to_string());
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferred")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "OwnershipTransferred"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "previous_owner", "OwnershipTransferred", e
                    ));
                }
            };
            key_offset +=
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "new_owner", "OwnershipTransferred", e
                    ));
                }
            };
            key_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
            return Ok(OwnableCptEvent::OwnershipTransferred(
                OwnershipTransferred {
                    previous_owner,
                    new_owner,
                },
            ));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferStarted")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "OwnershipTransferStarted"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "previous_owner", "OwnershipTransferStarted", e
                    ));
                }
            };
            key_offset +=
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "new_owner", "OwnershipTransferStarted", e
                    ));
                }
            };
            key_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
            return Ok(OwnableCptEvent::OwnershipTransferStarted(
                OwnershipTransferStarted {
                    previous_owner,
                    new_owner,
                },
            ));
        }
        Err(format!(
            "Could not match any event from keys {:?}",
            event.keys
        ))
    }
}
#[derive(Debug, PartialEq, PartialOrd, Clone)]
pub enum Event {
    DefaultIsmSet(DefaultIsmSet),
    DefaultHookSet(DefaultHookSet),
    RequiredHookSet(RequiredHookSet),
    Process(Process),
    ProcessId(ProcessId),
    Dispatch(Dispatch),
    DispatchId(DispatchId),
    OwnableEvent(OwnableCptEvent),
    UpgradeableEvent(UpgradeableCptEvent),
}
impl cainome::cairo_serde::CairoSerde for Event {
    type RustType = Self;
    const SERIALIZED_SIZE: std::option::Option<usize> = std::option::Option::None;
    #[inline]
    fn cairo_serialized_size(__rust: &Self::RustType) -> usize {
        match __rust {
            Event::DefaultIsmSet(val) => DefaultIsmSet::cairo_serialized_size(val) + 1,
            Event::DefaultHookSet(val) => DefaultHookSet::cairo_serialized_size(val) + 1,
            Event::RequiredHookSet(val) => RequiredHookSet::cairo_serialized_size(val) + 1,
            Event::Process(val) => Process::cairo_serialized_size(val) + 1,
            Event::ProcessId(val) => ProcessId::cairo_serialized_size(val) + 1,
            Event::Dispatch(val) => Dispatch::cairo_serialized_size(val) + 1,
            Event::DispatchId(val) => DispatchId::cairo_serialized_size(val) + 1,
            Event::OwnableEvent(val) => OwnableCptEvent::cairo_serialized_size(val) + 1,
            Event::UpgradeableEvent(val) => UpgradeableCptEvent::cairo_serialized_size(val) + 1,
            _ => 0,
        }
    }
    fn cairo_serialize(__rust: &Self::RustType) -> Vec<starknet::core::types::FieldElement> {
        match __rust {
            Event::DefaultIsmSet(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&0usize));
                temp.extend(DefaultIsmSet::cairo_serialize(val));
                temp
            }
            Event::DefaultHookSet(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&1usize));
                temp.extend(DefaultHookSet::cairo_serialize(val));
                temp
            }
            Event::RequiredHookSet(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&2usize));
                temp.extend(RequiredHookSet::cairo_serialize(val));
                temp
            }
            Event::Process(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&3usize));
                temp.extend(Process::cairo_serialize(val));
                temp
            }
            Event::ProcessId(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&4usize));
                temp.extend(ProcessId::cairo_serialize(val));
                temp
            }
            Event::Dispatch(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&5usize));
                temp.extend(Dispatch::cairo_serialize(val));
                temp
            }
            Event::DispatchId(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&6usize));
                temp.extend(DispatchId::cairo_serialize(val));
                temp
            }
            Event::OwnableEvent(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&7usize));
                temp.extend(OwnableCptEvent::cairo_serialize(val));
                temp
            }
            Event::UpgradeableEvent(val) => {
                let mut temp = vec![];
                temp.extend(usize::cairo_serialize(&8usize));
                temp.extend(UpgradeableCptEvent::cairo_serialize(val));
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
            0usize => Ok(Event::DefaultIsmSet(DefaultIsmSet::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            1usize => Ok(Event::DefaultHookSet(DefaultHookSet::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            2usize => Ok(Event::RequiredHookSet(RequiredHookSet::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            3usize => Ok(Event::Process(Process::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            4usize => Ok(Event::ProcessId(ProcessId::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            5usize => Ok(Event::Dispatch(Dispatch::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            6usize => Ok(Event::DispatchId(DispatchId::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            7usize => Ok(Event::OwnableEvent(OwnableCptEvent::cairo_deserialize(
                __felts,
                __offset + 1,
            )?)),
            8usize => Ok(Event::UpgradeableEvent(
                UpgradeableCptEvent::cairo_deserialize(__felts, __offset + 1)?,
            )),
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
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("DefaultIsmSet")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "DefaultIsmSet"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let module = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "module", "DefaultIsmSet", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&module);
            return Ok(Event::DefaultIsmSet(DefaultIsmSet { module }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("DefaultHookSet")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "DefaultHookSet"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let hook = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "hook", "DefaultHookSet", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&hook);
            return Ok(Event::DefaultHookSet(DefaultHookSet { hook }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("RequiredHookSet")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "RequiredHookSet"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let hook = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "hook", "RequiredHookSet", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&hook);
            return Ok(Event::RequiredHookSet(RequiredHookSet { hook }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("Process")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "Process"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let origin = match u32::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "origin", "Process", e
                    ));
                }
            };
            data_offset += u32::cairo_serialized_size(&origin);
            let sender =
                match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "sender", "Process", e
                        ));
                    }
                };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&sender);
            let recipient =
                match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "recipient", "Process", e
                        ));
                    }
                };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&recipient);
            return Ok(Event::Process(Process {
                origin,
                sender,
                recipient,
            }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("ProcessId")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "ProcessId"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let id = match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "id", "ProcessId", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
            return Ok(Event::ProcessId(ProcessId { id }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("Dispatch")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "Dispatch"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let sender =
                match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "sender", "Dispatch", e
                        ));
                    }
                };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&sender);
            let destination_domain = match u32::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "destination_domain", "Dispatch", e
                    ));
                }
            };
            data_offset += u32::cairo_serialized_size(&destination_domain);
            let recipient_address =
                match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(format!(
                            "Could not deserialize field {} for {}: {:?}",
                            "recipient_address", "Dispatch", e
                        ));
                    }
                };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&recipient_address);
            let message = match Message::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "message", "Dispatch", e
                    ));
                }
            };
            data_offset += Message::cairo_serialized_size(&message);
            return Ok(Event::Dispatch(Dispatch {
                sender,
                destination_domain,
                recipient_address,
                message,
            }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("DispatchId")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "DispatchId"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let id = match cainome::cairo_serde::U256::cairo_deserialize(&event.data, data_offset) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "id", "DispatchId", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::U256::cairo_serialized_size(&id);
            return Ok(Event::DispatchId(DispatchId { id }));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferred")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "OwnershipTransferred"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "previous_owner", "OwnershipTransferred", e
                    ));
                }
            };
            key_offset +=
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "new_owner", "OwnershipTransferred", e
                    ));
                }
            };
            key_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
            return Ok(Event::OwnableEvent(OwnableCptEvent::OwnershipTransferred(
                OwnershipTransferred {
                    previous_owner,
                    new_owner,
                },
            )));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("OwnershipTransferStarted")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "OwnershipTransferStarted"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let previous_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "previous_owner", "OwnershipTransferStarted", e
                    ));
                }
            };
            key_offset +=
                cainome::cairo_serde::ContractAddress::cairo_serialized_size(&previous_owner);
            let new_owner = match cainome::cairo_serde::ContractAddress::cairo_deserialize(
                &event.keys,
                key_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "new_owner", "OwnershipTransferStarted", e
                    ));
                }
            };
            key_offset += cainome::cairo_serde::ContractAddress::cairo_serialized_size(&new_owner);
            return Ok(Event::OwnableEvent(
                OwnableCptEvent::OwnershipTransferStarted(OwnershipTransferStarted {
                    previous_owner,
                    new_owner,
                }),
            ));
        }
        let selector = event.keys[0];
        if selector
            == starknet::core::utils::get_selector_from_name("Upgraded")
                .unwrap_or_else(|_| panic!("Invalid selector for {}", "Upgraded"))
        {
            let mut key_offset = 0 + 1;
            let mut data_offset = 0;
            let class_hash = match cainome::cairo_serde::ClassHash::cairo_deserialize(
                &event.data,
                data_offset,
            ) {
                Ok(v) => v,
                Err(e) => {
                    return Err(format!(
                        "Could not deserialize field {} for {}: {:?}",
                        "class_hash", "Upgraded", e
                    ));
                }
            };
            data_offset += cainome::cairo_serde::ClassHash::cairo_serialized_size(&class_hash);
            return Ok(Event::UpgradeableEvent(UpgradeableCptEvent::Upgraded(
                Upgraded { class_hash },
            )));
        }
        Err(format!(
            "Could not match any event from keys {:?}",
            event.keys
        ))
    }
}
impl<A: starknet::accounts::ConnectedAccount + Sync> Mailbox<A> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_local_domain(&self) -> cainome::cairo_serde::call::FCall<A::Provider, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_local_domain"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn delivered(
        &self,
        _message_id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_message_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("delivered"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn nonce(&self) -> cainome::cairo_serde::call::FCall<A::Provider, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("nonce"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_default_ism(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_default_ism"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_default_hook(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_default_hook"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_required_hook(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_required_hook"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_latest_dispatched_id(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_latest_dispatched_id"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn quote_dispatch(
        &self,
        _destination_domain: &u32,
        _recipient_address: &cainome::cairo_serde::U256,
        _message_body: &Bytes,
        _custom_hook_metadata: &Option<Bytes>,
        _custom_hook: &Option<Bytes>,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(u32::cairo_serialize(_destination_domain));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(
            _recipient_address,
        ));
        __calldata.extend(Bytes::cairo_serialize(_message_body));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook_metadata));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("quote_dispatch"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn recipient_ism(
        &self,
        _recipient: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_recipient));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("recipient_ism"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn processor(
        &self,
        _id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("processor"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn processed_at(
        &self,
        _id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, u64> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("processed_at"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn owner(
        &self,
    ) -> cainome::cairo_serde::call::FCall<A::Provider, cainome::cairo_serde::ContractAddress> {
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
    pub fn dispatch_getcall(
        &self,
        _destination_domain: &u32,
        _recipient_address: &cainome::cairo_serde::U256,
        _message_body: &Bytes,
        _fee_amount: &cainome::cairo_serde::U256,
        _custom_hook_metadata: &Option<Bytes>,
        _custom_hook: &Option<Bytes>,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(u32::cairo_serialize(_destination_domain));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(
            _recipient_address,
        ));
        __calldata.extend(Bytes::cairo_serialize(_message_body));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_fee_amount));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook_metadata));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("dispatch"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn dispatch(
        &self,
        _destination_domain: &u32,
        _recipient_address: &cainome::cairo_serde::U256,
        _message_body: &Bytes,
        _fee_amount: &cainome::cairo_serde::U256,
        _custom_hook_metadata: &Option<Bytes>,
        _custom_hook: &Option<Bytes>,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(u32::cairo_serialize(_destination_domain));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(
            _recipient_address,
        ));
        __calldata.extend(Bytes::cairo_serialize(_message_body));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_fee_amount));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook_metadata));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("dispatch"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_getcall(
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
            selector: starknet::macros::selector!("process"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn process(
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
            selector: starknet::macros::selector!("process"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_default_ism_getcall(
        &self,
        _module: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _module,
        ));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_default_ism"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn set_default_ism(
        &self,
        _module: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _module,
        ));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_default_ism"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_default_hook_getcall(
        &self,
        _hook: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _hook,
        ));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_default_hook"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn set_default_hook(
        &self,
        _hook: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _hook,
        ));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_default_hook"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_required_hook_getcall(
        &self,
        _hook: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _hook,
        ));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_required_hook"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn set_required_hook(
        &self,
        _hook: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            _hook,
        ));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("set_required_hook"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn upgrade_getcall(
        &self,
        new_class_hash: &cainome::cairo_serde::ClassHash,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ClassHash::cairo_serialize(
            new_class_hash,
        ));
        starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("upgrade"),
            calldata: __calldata,
        }
    }
    #[allow(clippy::ptr_arg)]
    pub fn upgrade(
        &self,
        new_class_hash: &cainome::cairo_serde::ClassHash,
    ) -> starknet::accounts::Execution<A> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ClassHash::cairo_serialize(
            new_class_hash,
        ));
        let __call = starknet::accounts::Call {
            to: self.address,
            selector: starknet::macros::selector!("upgrade"),
            calldata: __calldata,
        };
        self.account.execute(vec![__call])
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_ownership_getcall(
        &self,
        new_owner: &cainome::cairo_serde::ContractAddress,
    ) -> starknet::accounts::Call {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            new_owner,
        ));
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
        __calldata.extend(cainome::cairo_serde::ContractAddress::cairo_serialize(
            new_owner,
        ));
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
}
impl<P: starknet::providers::Provider + Sync> MailboxReader<P> {
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_local_domain(&self) -> cainome::cairo_serde::call::FCall<P, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_local_domain"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn delivered(
        &self,
        _message_id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<P, bool> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_message_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("delivered"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn nonce(&self) -> cainome::cairo_serde::call::FCall<P, u32> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("nonce"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_default_ism(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_default_ism"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_default_hook(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_default_hook"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_required_hook(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_required_hook"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_latest_dispatched_id(
        &self,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("get_latest_dispatched_id"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn quote_dispatch(
        &self,
        _destination_domain: &u32,
        _recipient_address: &cainome::cairo_serde::U256,
        _message_body: &Bytes,
        _custom_hook_metadata: &Option<Bytes>,
        _custom_hook: &Option<Bytes>,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::U256> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(u32::cairo_serialize(_destination_domain));
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(
            _recipient_address,
        ));
        __calldata.extend(Bytes::cairo_serialize(_message_body));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook_metadata));
        __calldata.extend(Option::<Bytes>::cairo_serialize(_custom_hook));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("quote_dispatch"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn recipient_ism(
        &self,
        _recipient: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_recipient));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("recipient_ism"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn processor(
        &self,
        _id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<P, cainome::cairo_serde::ContractAddress> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("processor"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
    #[allow(clippy::ptr_arg)]
    #[allow(clippy::too_many_arguments)]
    pub fn processed_at(
        &self,
        _id: &cainome::cairo_serde::U256,
    ) -> cainome::cairo_serde::call::FCall<P, u64> {
        use cainome::cairo_serde::CairoSerde;
        let mut __calldata = vec![];
        __calldata.extend(cainome::cairo_serde::U256::cairo_serialize(_id));
        let __call = starknet::core::types::FunctionCall {
            contract_address: self.address,
            entry_point_selector: starknet::macros::selector!("processed_at"),
            calldata: __calldata,
        };
        cainome::cairo_serde::call::FCall::new(__call, self.provider())
    }
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
}
