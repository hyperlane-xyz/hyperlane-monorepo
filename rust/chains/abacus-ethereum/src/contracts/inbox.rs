pub use inbox::*;
#[allow(clippy::too_many_arguments, non_camel_case_types)]
pub mod inbox {
    #![allow(clippy::enum_variant_names)]
    #![allow(dead_code)]
    #![allow(clippy::type_complexity)]
    #![allow(unused_imports)]
    use ethers::contract::{
        builders::{ContractCall, Event},
        Contract, Lazy,
    };
    use ethers::core::{
        abi::{Abi, Detokenize, InvalidOutputType, Token, Tokenizable},
        types::*,
    };
    use ethers::providers::Middleware;
    #[doc = "Inbox was auto-generated with ethers-rs Abigen. More information at: https://github.com/gakonst/ethers-rs"]
    use std::sync::Arc;
    # [rustfmt :: skip] const __ABI : & str = "[\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"_localDomain\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"constructor\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": false,\n        \"internalType\": \"uint8\",\n        \"name\": \"version\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"name\": \"Initialized\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"previousOwner\",\n        \"type\": \"address\"\n      },\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"OwnershipTransferred\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"bytes32\",\n        \"name\": \"messageHash\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"name\": \"Process\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": false,\n        \"internalType\": \"address\",\n        \"name\": \"validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"ValidatorManagerSet\",\n    \"type\": \"event\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"VERSION\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint8\",\n        \"name\": \"\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"_remoteDomain\",\n        \"type\": \"uint32\"\n      },\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"initialize\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"localDomain\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"name\": \"messages\",\n    \"outputs\": [\n      {\n        \"internalType\": \"enum Inbox.MessageStatus\",\n        \"name\": \"\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"owner\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"\",\n        \"type\": \"address\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"_root\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_index\",\n        \"type\": \"uint256\"\n      },\n      {\n        \"internalType\": \"bytes\",\n        \"name\": \"_message\",\n        \"type\": \"bytes\"\n      },\n      {\n        \"internalType\": \"bytes32[32]\",\n        \"name\": \"_proof\",\n        \"type\": \"bytes32[32]\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_leafIndex\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"process\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"remoteDomain\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"renounceOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"setValidatorManager\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"transferOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"validatorManager\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"\",\n        \"type\": \"address\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  }\n]\n" ;
    #[doc = r" The parsed JSON-ABI of the contract."]
    pub static INBOX_ABI: ethers::contract::Lazy<ethers::core::abi::Abi> =
        ethers::contract::Lazy::new(|| {
            ethers::core::utils::__serde_json::from_str(__ABI).expect("invalid abi")
        });
    pub struct Inbox<M>(ethers::contract::Contract<M>);
    impl<M> Clone for Inbox<M> {
        fn clone(&self) -> Self {
            Inbox(self.0.clone())
        }
    }
    impl<M> std::ops::Deref for Inbox<M> {
        type Target = ethers::contract::Contract<M>;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl<M> std::fmt::Debug for Inbox<M> {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.debug_tuple(stringify!(Inbox))
                .field(&self.address())
                .finish()
        }
    }
    impl<M: ethers::providers::Middleware> Inbox<M> {
        #[doc = r" Creates a new contract instance with the specified `ethers`"]
        #[doc = r" client at the given `Address`. The contract derefs to a `ethers::Contract`"]
        #[doc = r" object"]
        pub fn new<T: Into<ethers::core::types::Address>>(
            address: T,
            client: ::std::sync::Arc<M>,
        ) -> Self {
            ethers::contract::Contract::new(address.into(), INBOX_ABI.clone(), client).into()
        }
        #[doc = "Calls the contract's `VERSION` (0xffa1ad74) function"]
        pub fn version(&self) -> ethers::contract::builders::ContractCall<M, u8> {
            self.0
                .method_hash([255, 161, 173, 116], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `initialize` (0x8624c35c) function"]
        pub fn initialize(
            &self,
            remote_domain: u32,
            validator_manager: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([134, 36, 195, 92], (remote_domain, validator_manager))
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `localDomain` (0x8d3638f4) function"]
        pub fn local_domain(&self) -> ethers::contract::builders::ContractCall<M, u32> {
            self.0
                .method_hash([141, 54, 56, 244], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `messages` (0x2bbd59ca) function"]
        pub fn messages(&self, p0: [u8; 32]) -> ethers::contract::builders::ContractCall<M, u8> {
            self.0
                .method_hash([43, 189, 89, 202], p0)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `owner` (0x8da5cb5b) function"]
        pub fn owner(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::Address> {
            self.0
                .method_hash([141, 165, 203, 91], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `process` (0xc238c980) function"]
        pub fn process(
            &self,
            root: [u8; 32],
            index: ethers::core::types::U256,
            message: ethers::core::types::Bytes,
            proof: [[u8; 32]; 32usize],
            leaf_index: ethers::core::types::U256,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash(
                    [194, 56, 201, 128],
                    (root, index, message, proof, leaf_index),
                )
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `remoteDomain` (0x961681dc) function"]
        pub fn remote_domain(&self) -> ethers::contract::builders::ContractCall<M, u32> {
            self.0
                .method_hash([150, 22, 129, 220], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `renounceOwnership` (0x715018a6) function"]
        pub fn renounce_ownership(&self) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([113, 80, 24, 166], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `setValidatorManager` (0x45f34e92) function"]
        pub fn set_validator_manager(
            &self,
            validator_manager: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([69, 243, 78, 146], validator_manager)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `transferOwnership` (0xf2fde38b) function"]
        pub fn transfer_ownership(
            &self,
            new_owner: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([242, 253, 227, 139], new_owner)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `validatorManager` (0xfe55bde9) function"]
        pub fn validator_manager(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::Address> {
            self.0
                .method_hash([254, 85, 189, 233], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Gets the contract's `Initialized` event"]
        pub fn initialized_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, InitializedFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `OwnershipTransferred` event"]
        pub fn ownership_transferred_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, OwnershipTransferredFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `Process` event"]
        pub fn process_filter(&self) -> ethers::contract::builders::Event<M, ProcessFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `ValidatorManagerSet` event"]
        pub fn validator_manager_set_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, ValidatorManagerSetFilter> {
            self.0.event()
        }
        #[doc = r" Returns an [`Event`](#ethers_contract::builders::Event) builder for all events of this contract"]
        pub fn events(&self) -> ethers::contract::builders::Event<M, InboxEvents> {
            self.0.event_with_filter(Default::default())
        }
    }
    impl<M: ethers::providers::Middleware> From<ethers::contract::Contract<M>> for Inbox<M> {
        fn from(contract: ethers::contract::Contract<M>) -> Self {
            Self(contract)
        }
    }
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthEvent,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethevent(name = "Initialized", abi = "Initialized(uint8)")]
    pub struct InitializedFilter {
        pub version: u8,
    }
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthEvent,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethevent(
        name = "OwnershipTransferred",
        abi = "OwnershipTransferred(address,address)"
    )]
    pub struct OwnershipTransferredFilter {
        #[ethevent(indexed)]
        pub previous_owner: ethers::core::types::Address,
        #[ethevent(indexed)]
        pub new_owner: ethers::core::types::Address,
    }
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthEvent,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethevent(name = "Process", abi = "Process(bytes32)")]
    pub struct ProcessFilter {
        #[ethevent(indexed)]
        pub message_hash: [u8; 32],
    }
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthEvent,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethevent(name = "ValidatorManagerSet", abi = "ValidatorManagerSet(address)")]
    pub struct ValidatorManagerSetFilter {
        pub validator_manager: ethers::core::types::Address,
    }
    #[derive(Debug, Clone, PartialEq, Eq, ethers :: contract :: EthAbiType)]
    pub enum InboxEvents {
        InitializedFilter(InitializedFilter),
        OwnershipTransferredFilter(OwnershipTransferredFilter),
        ProcessFilter(ProcessFilter),
        ValidatorManagerSetFilter(ValidatorManagerSetFilter),
    }
    impl ethers::contract::EthLogDecode for InboxEvents {
        fn decode_log(
            log: &ethers::core::abi::RawLog,
        ) -> ::std::result::Result<Self, ethers::core::abi::Error>
        where
            Self: Sized,
        {
            if let Ok(decoded) = InitializedFilter::decode_log(log) {
                return Ok(InboxEvents::InitializedFilter(decoded));
            }
            if let Ok(decoded) = OwnershipTransferredFilter::decode_log(log) {
                return Ok(InboxEvents::OwnershipTransferredFilter(decoded));
            }
            if let Ok(decoded) = ProcessFilter::decode_log(log) {
                return Ok(InboxEvents::ProcessFilter(decoded));
            }
            if let Ok(decoded) = ValidatorManagerSetFilter::decode_log(log) {
                return Ok(InboxEvents::ValidatorManagerSetFilter(decoded));
            }
            Err(ethers::core::abi::Error::InvalidData)
        }
    }
    impl ::std::fmt::Display for InboxEvents {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                InboxEvents::InitializedFilter(element) => element.fmt(f),
                InboxEvents::OwnershipTransferredFilter(element) => element.fmt(f),
                InboxEvents::ProcessFilter(element) => element.fmt(f),
                InboxEvents::ValidatorManagerSetFilter(element) => element.fmt(f),
            }
        }
    }
    #[doc = "Container type for all input parameters for the `VERSION` function with signature `VERSION()` and selector `[255, 161, 173, 116]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "VERSION", abi = "VERSION()")]
    pub struct VersionCall;
    #[doc = "Container type for all input parameters for the `initialize` function with signature `initialize(uint32,address)` and selector `[134, 36, 195, 92]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "initialize", abi = "initialize(uint32,address)")]
    pub struct InitializeCall {
        pub remote_domain: u32,
        pub validator_manager: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `localDomain` function with signature `localDomain()` and selector `[141, 54, 56, 244]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "localDomain", abi = "localDomain()")]
    pub struct LocalDomainCall;
    #[doc = "Container type for all input parameters for the `messages` function with signature `messages(bytes32)` and selector `[43, 189, 89, 202]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "messages", abi = "messages(bytes32)")]
    pub struct MessagesCall(pub [u8; 32]);
    #[doc = "Container type for all input parameters for the `owner` function with signature `owner()` and selector `[141, 165, 203, 91]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "owner", abi = "owner()")]
    pub struct OwnerCall;
    #[doc = "Container type for all input parameters for the `process` function with signature `process(bytes32,uint256,bytes,bytes32[32],uint256)` and selector `[194, 56, 201, 128]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(
        name = "process",
        abi = "process(bytes32,uint256,bytes,bytes32[32],uint256)"
    )]
    pub struct ProcessCall {
        pub root: [u8; 32],
        pub index: ethers::core::types::U256,
        pub message: ethers::core::types::Bytes,
        pub proof: [[u8; 32]; 32usize],
        pub leaf_index: ethers::core::types::U256,
    }
    #[doc = "Container type for all input parameters for the `remoteDomain` function with signature `remoteDomain()` and selector `[150, 22, 129, 220]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "remoteDomain", abi = "remoteDomain()")]
    pub struct RemoteDomainCall;
    #[doc = "Container type for all input parameters for the `renounceOwnership` function with signature `renounceOwnership()` and selector `[113, 80, 24, 166]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "renounceOwnership", abi = "renounceOwnership()")]
    pub struct RenounceOwnershipCall;
    #[doc = "Container type for all input parameters for the `setValidatorManager` function with signature `setValidatorManager(address)` and selector `[69, 243, 78, 146]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "setValidatorManager", abi = "setValidatorManager(address)")]
    pub struct SetValidatorManagerCall {
        pub validator_manager: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `transferOwnership` function with signature `transferOwnership(address)` and selector `[242, 253, 227, 139]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "transferOwnership", abi = "transferOwnership(address)")]
    pub struct TransferOwnershipCall {
        pub new_owner: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `validatorManager` function with signature `validatorManager()` and selector `[254, 85, 189, 233]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "validatorManager", abi = "validatorManager()")]
    pub struct ValidatorManagerCall;
    #[derive(Debug, Clone, PartialEq, Eq, ethers :: contract :: EthAbiType)]
    pub enum InboxCalls {
        Version(VersionCall),
        Initialize(InitializeCall),
        LocalDomain(LocalDomainCall),
        Messages(MessagesCall),
        Owner(OwnerCall),
        Process(ProcessCall),
        RemoteDomain(RemoteDomainCall),
        RenounceOwnership(RenounceOwnershipCall),
        SetValidatorManager(SetValidatorManagerCall),
        TransferOwnership(TransferOwnershipCall),
        ValidatorManager(ValidatorManagerCall),
    }
    impl ethers::core::abi::AbiDecode for InboxCalls {
        fn decode(
            data: impl AsRef<[u8]>,
        ) -> ::std::result::Result<Self, ethers::core::abi::AbiError> {
            if let Ok(decoded) =
                <VersionCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::Version(decoded));
            }
            if let Ok(decoded) =
                <InitializeCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::Initialize(decoded));
            }
            if let Ok(decoded) =
                <LocalDomainCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::LocalDomain(decoded));
            }
            if let Ok(decoded) =
                <MessagesCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::Messages(decoded));
            }
            if let Ok(decoded) = <OwnerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::Owner(decoded));
            }
            if let Ok(decoded) =
                <ProcessCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::Process(decoded));
            }
            if let Ok(decoded) =
                <RemoteDomainCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::RemoteDomain(decoded));
            }
            if let Ok(decoded) =
                <RenounceOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::RenounceOwnership(decoded));
            }
            if let Ok(decoded) =
                <SetValidatorManagerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::SetValidatorManager(decoded));
            }
            if let Ok(decoded) =
                <TransferOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::TransferOwnership(decoded));
            }
            if let Ok(decoded) =
                <ValidatorManagerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxCalls::ValidatorManager(decoded));
            }
            Err(ethers::core::abi::Error::InvalidData.into())
        }
    }
    impl ethers::core::abi::AbiEncode for InboxCalls {
        fn encode(self) -> Vec<u8> {
            match self {
                InboxCalls::Version(element) => element.encode(),
                InboxCalls::Initialize(element) => element.encode(),
                InboxCalls::LocalDomain(element) => element.encode(),
                InboxCalls::Messages(element) => element.encode(),
                InboxCalls::Owner(element) => element.encode(),
                InboxCalls::Process(element) => element.encode(),
                InboxCalls::RemoteDomain(element) => element.encode(),
                InboxCalls::RenounceOwnership(element) => element.encode(),
                InboxCalls::SetValidatorManager(element) => element.encode(),
                InboxCalls::TransferOwnership(element) => element.encode(),
                InboxCalls::ValidatorManager(element) => element.encode(),
            }
        }
    }
    impl ::std::fmt::Display for InboxCalls {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                InboxCalls::Version(element) => element.fmt(f),
                InboxCalls::Initialize(element) => element.fmt(f),
                InboxCalls::LocalDomain(element) => element.fmt(f),
                InboxCalls::Messages(element) => element.fmt(f),
                InboxCalls::Owner(element) => element.fmt(f),
                InboxCalls::Process(element) => element.fmt(f),
                InboxCalls::RemoteDomain(element) => element.fmt(f),
                InboxCalls::RenounceOwnership(element) => element.fmt(f),
                InboxCalls::SetValidatorManager(element) => element.fmt(f),
                InboxCalls::TransferOwnership(element) => element.fmt(f),
                InboxCalls::ValidatorManager(element) => element.fmt(f),
            }
        }
    }
    impl ::std::convert::From<VersionCall> for InboxCalls {
        fn from(var: VersionCall) -> Self {
            InboxCalls::Version(var)
        }
    }
    impl ::std::convert::From<InitializeCall> for InboxCalls {
        fn from(var: InitializeCall) -> Self {
            InboxCalls::Initialize(var)
        }
    }
    impl ::std::convert::From<LocalDomainCall> for InboxCalls {
        fn from(var: LocalDomainCall) -> Self {
            InboxCalls::LocalDomain(var)
        }
    }
    impl ::std::convert::From<MessagesCall> for InboxCalls {
        fn from(var: MessagesCall) -> Self {
            InboxCalls::Messages(var)
        }
    }
    impl ::std::convert::From<OwnerCall> for InboxCalls {
        fn from(var: OwnerCall) -> Self {
            InboxCalls::Owner(var)
        }
    }
    impl ::std::convert::From<ProcessCall> for InboxCalls {
        fn from(var: ProcessCall) -> Self {
            InboxCalls::Process(var)
        }
    }
    impl ::std::convert::From<RemoteDomainCall> for InboxCalls {
        fn from(var: RemoteDomainCall) -> Self {
            InboxCalls::RemoteDomain(var)
        }
    }
    impl ::std::convert::From<RenounceOwnershipCall> for InboxCalls {
        fn from(var: RenounceOwnershipCall) -> Self {
            InboxCalls::RenounceOwnership(var)
        }
    }
    impl ::std::convert::From<SetValidatorManagerCall> for InboxCalls {
        fn from(var: SetValidatorManagerCall) -> Self {
            InboxCalls::SetValidatorManager(var)
        }
    }
    impl ::std::convert::From<TransferOwnershipCall> for InboxCalls {
        fn from(var: TransferOwnershipCall) -> Self {
            InboxCalls::TransferOwnership(var)
        }
    }
    impl ::std::convert::From<ValidatorManagerCall> for InboxCalls {
        fn from(var: ValidatorManagerCall) -> Self {
            InboxCalls::ValidatorManager(var)
        }
    }
    #[doc = "Container type for all return fields from the `VERSION` function with signature `VERSION()` and selector `[255, 161, 173, 116]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct VersionReturn(pub u8);
    #[doc = "Container type for all return fields from the `localDomain` function with signature `localDomain()` and selector `[141, 54, 56, 244]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct LocalDomainReturn(pub u32);
    #[doc = "Container type for all return fields from the `messages` function with signature `messages(bytes32)` and selector `[43, 189, 89, 202]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct MessagesReturn(pub u8);
    #[doc = "Container type for all return fields from the `owner` function with signature `owner()` and selector `[141, 165, 203, 91]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct OwnerReturn(pub ethers::core::types::Address);
    #[doc = "Container type for all return fields from the `remoteDomain` function with signature `remoteDomain()` and selector `[150, 22, 129, 220]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct RemoteDomainReturn(pub u32);
    #[doc = "Container type for all return fields from the `validatorManager` function with signature `validatorManager()` and selector `[254, 85, 189, 233]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct ValidatorManagerReturn(pub ethers::core::types::Address);
}
