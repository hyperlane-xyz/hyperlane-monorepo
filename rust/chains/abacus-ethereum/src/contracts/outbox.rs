pub use outbox::*;
#[allow(clippy::too_many_arguments, non_camel_case_types)]
pub mod outbox {
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
    #[doc = "Outbox was auto-generated with ethers-rs Abigen. More information at: https://github.com/gakonst/ethers-rs"]
    use std::sync::Arc;
    # [rustfmt :: skip] const __ABI : & str = "[\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"_localDomain\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"constructor\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"bytes32\",\n        \"name\": \"root\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"indexed\": true,\n        \"internalType\": \"uint256\",\n        \"name\": \"index\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"CheckpointCached\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"uint256\",\n        \"name\": \"leafIndex\",\n        \"type\": \"uint256\"\n      },\n      {\n        \"indexed\": false,\n        \"internalType\": \"bytes\",\n        \"name\": \"message\",\n        \"type\": \"bytes\"\n      }\n    ],\n    \"name\": \"Dispatch\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [],\n    \"name\": \"Fail\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": false,\n        \"internalType\": \"uint8\",\n        \"name\": \"version\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"name\": \"Initialized\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"previousOwner\",\n        \"type\": \"address\"\n      },\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"OwnershipTransferred\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": false,\n        \"internalType\": \"address\",\n        \"name\": \"validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"ValidatorManagerSet\",\n    \"type\": \"event\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"MAX_MESSAGE_BODY_BYTES\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"VERSION\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint8\",\n        \"name\": \"\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"cacheCheckpoint\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"name\": \"cachedCheckpoints\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"count\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"_destinationDomain\",\n        \"type\": \"uint32\"\n      },\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"_recipientAddress\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"bytes\",\n        \"name\": \"_messageBody\",\n        \"type\": \"bytes\"\n      }\n    ],\n    \"name\": \"dispatch\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"fail\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"initialize\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"latestCachedCheckpoint\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"root\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"index\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"latestCachedRoot\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"latestCheckpoint\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"localDomain\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"owner\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"\",\n        \"type\": \"address\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"renounceOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"root\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validatorManager\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"setValidatorManager\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"state\",\n    \"outputs\": [\n      {\n        \"internalType\": \"enum Outbox.States\",\n        \"name\": \"\",\n        \"type\": \"uint8\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"transferOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"tree\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"count\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"validatorManager\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"\",\n        \"type\": \"address\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  }\n]\n" ;
    #[doc = r" The parsed JSON-ABI of the contract."]
    pub static OUTBOX_ABI: ethers::contract::Lazy<ethers::core::abi::Abi> =
        ethers::contract::Lazy::new(|| {
            ethers::core::utils::__serde_json::from_str(__ABI).expect("invalid abi")
        });
    pub struct Outbox<M>(ethers::contract::Contract<M>);
    impl<M> Clone for Outbox<M> {
        fn clone(&self) -> Self {
            Outbox(self.0.clone())
        }
    }
    impl<M> std::ops::Deref for Outbox<M> {
        type Target = ethers::contract::Contract<M>;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl<M> std::fmt::Debug for Outbox<M> {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.debug_tuple(stringify!(Outbox))
                .field(&self.address())
                .finish()
        }
    }
    impl<M: ethers::providers::Middleware> Outbox<M> {
        #[doc = r" Creates a new contract instance with the specified `ethers`"]
        #[doc = r" client at the given `Address`. The contract derefs to a `ethers::Contract`"]
        #[doc = r" object"]
        pub fn new<T: Into<ethers::core::types::Address>>(
            address: T,
            client: ::std::sync::Arc<M>,
        ) -> Self {
            ethers::contract::Contract::new(address.into(), OUTBOX_ABI.clone(), client).into()
        }
        #[doc = "Calls the contract's `MAX_MESSAGE_BODY_BYTES` (0x522ae002) function"]
        pub fn max_message_body_bytes(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([82, 42, 224, 2], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `VERSION` (0xffa1ad74) function"]
        pub fn version(&self) -> ethers::contract::builders::ContractCall<M, u8> {
            self.0
                .method_hash([255, 161, 173, 116], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `cacheCheckpoint` (0x4cf7759b) function"]
        pub fn cache_checkpoint(&self) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([76, 247, 117, 155], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `cachedCheckpoints` (0xe4716647) function"]
        pub fn cached_checkpoints(
            &self,
            p0: [u8; 32],
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([228, 113, 102, 71], p0)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `count` (0x06661abd) function"]
        pub fn count(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([6, 102, 26, 189], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `dispatch` (0xfa31de01) function"]
        pub fn dispatch(
            &self,
            destination_domain: u32,
            recipient_address: [u8; 32],
            message_body: ethers::core::types::Bytes,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash(
                    [250, 49, 222, 1],
                    (destination_domain, recipient_address, message_body),
                )
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `fail` (0xa9cc4718) function"]
        pub fn fail(&self) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([169, 204, 71, 24], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `initialize` (0xc4d66de8) function"]
        pub fn initialize(
            &self,
            validator_manager: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([196, 214, 109, 232], validator_manager)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `latestCachedCheckpoint` (0xdb5a684b) function"]
        pub fn latest_cached_checkpoint(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ([u8; 32], ethers::core::types::U256)>
        {
            self.0
                .method_hash([219, 90, 104, 75], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `latestCachedRoot` (0x84b9e849) function"]
        pub fn latest_cached_root(&self) -> ethers::contract::builders::ContractCall<M, [u8; 32]> {
            self.0
                .method_hash([132, 185, 232, 73], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `latestCheckpoint` (0x907c0f92) function"]
        pub fn latest_checkpoint(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ([u8; 32], ethers::core::types::U256)>
        {
            self.0
                .method_hash([144, 124, 15, 146], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `localDomain` (0x8d3638f4) function"]
        pub fn local_domain(&self) -> ethers::contract::builders::ContractCall<M, u32> {
            self.0
                .method_hash([141, 54, 56, 244], ())
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
        #[doc = "Calls the contract's `renounceOwnership` (0x715018a6) function"]
        pub fn renounce_ownership(&self) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([113, 80, 24, 166], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `root` (0xebf0c717) function"]
        pub fn root(&self) -> ethers::contract::builders::ContractCall<M, [u8; 32]> {
            self.0
                .method_hash([235, 240, 199, 23], ())
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
        #[doc = "Calls the contract's `state` (0xc19d93fb) function"]
        pub fn state(&self) -> ethers::contract::builders::ContractCall<M, u8> {
            self.0
                .method_hash([193, 157, 147, 251], ())
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
        #[doc = "Calls the contract's `tree` (0xfd54b228) function"]
        pub fn tree(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([253, 84, 178, 40], ())
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
        #[doc = "Gets the contract's `CheckpointCached` event"]
        pub fn checkpoint_cached_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, CheckpointCachedFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `Dispatch` event"]
        pub fn dispatch_filter(&self) -> ethers::contract::builders::Event<M, DispatchFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `Fail` event"]
        pub fn fail_filter(&self) -> ethers::contract::builders::Event<M, FailFilter> {
            self.0.event()
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
        #[doc = "Gets the contract's `ValidatorManagerSet` event"]
        pub fn validator_manager_set_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, ValidatorManagerSetFilter> {
            self.0.event()
        }
        #[doc = r" Returns an [`Event`](#ethers_contract::builders::Event) builder for all events of this contract"]
        pub fn events(&self) -> ethers::contract::builders::Event<M, OutboxEvents> {
            self.0.event_with_filter(Default::default())
        }
    }
    impl<M: ethers::providers::Middleware> From<ethers::contract::Contract<M>> for Outbox<M> {
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
    #[ethevent(name = "CheckpointCached", abi = "CheckpointCached(bytes32,uint256)")]
    pub struct CheckpointCachedFilter {
        #[ethevent(indexed)]
        pub root: [u8; 32],
        #[ethevent(indexed)]
        pub index: ethers::core::types::U256,
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
    #[ethevent(name = "Dispatch", abi = "Dispatch(uint256,bytes)")]
    pub struct DispatchFilter {
        #[ethevent(indexed)]
        pub leaf_index: ethers::core::types::U256,
        pub message: ethers::core::types::Bytes,
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
    #[ethevent(name = "Fail", abi = "Fail()")]
    pub struct FailFilter();
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
    #[ethevent(name = "ValidatorManagerSet", abi = "ValidatorManagerSet(address)")]
    pub struct ValidatorManagerSetFilter {
        pub validator_manager: ethers::core::types::Address,
    }
    #[derive(Debug, Clone, PartialEq, Eq, ethers :: contract :: EthAbiType)]
    pub enum OutboxEvents {
        CheckpointCachedFilter(CheckpointCachedFilter),
        DispatchFilter(DispatchFilter),
        FailFilter(FailFilter),
        InitializedFilter(InitializedFilter),
        OwnershipTransferredFilter(OwnershipTransferredFilter),
        ValidatorManagerSetFilter(ValidatorManagerSetFilter),
    }
    impl ethers::contract::EthLogDecode for OutboxEvents {
        fn decode_log(
            log: &ethers::core::abi::RawLog,
        ) -> ::std::result::Result<Self, ethers::core::abi::Error>
        where
            Self: Sized,
        {
            if let Ok(decoded) = CheckpointCachedFilter::decode_log(log) {
                return Ok(OutboxEvents::CheckpointCachedFilter(decoded));
            }
            if let Ok(decoded) = DispatchFilter::decode_log(log) {
                return Ok(OutboxEvents::DispatchFilter(decoded));
            }
            if let Ok(decoded) = FailFilter::decode_log(log) {
                return Ok(OutboxEvents::FailFilter(decoded));
            }
            if let Ok(decoded) = InitializedFilter::decode_log(log) {
                return Ok(OutboxEvents::InitializedFilter(decoded));
            }
            if let Ok(decoded) = OwnershipTransferredFilter::decode_log(log) {
                return Ok(OutboxEvents::OwnershipTransferredFilter(decoded));
            }
            if let Ok(decoded) = ValidatorManagerSetFilter::decode_log(log) {
                return Ok(OutboxEvents::ValidatorManagerSetFilter(decoded));
            }
            Err(ethers::core::abi::Error::InvalidData)
        }
    }
    impl ::std::fmt::Display for OutboxEvents {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                OutboxEvents::CheckpointCachedFilter(element) => element.fmt(f),
                OutboxEvents::DispatchFilter(element) => element.fmt(f),
                OutboxEvents::FailFilter(element) => element.fmt(f),
                OutboxEvents::InitializedFilter(element) => element.fmt(f),
                OutboxEvents::OwnershipTransferredFilter(element) => element.fmt(f),
                OutboxEvents::ValidatorManagerSetFilter(element) => element.fmt(f),
            }
        }
    }
    #[doc = "Container type for all input parameters for the `MAX_MESSAGE_BODY_BYTES` function with signature `MAX_MESSAGE_BODY_BYTES()` and selector `[82, 42, 224, 2]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "MAX_MESSAGE_BODY_BYTES", abi = "MAX_MESSAGE_BODY_BYTES()")]
    pub struct MaxMessageBodyBytesCall;
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
    #[doc = "Container type for all input parameters for the `cacheCheckpoint` function with signature `cacheCheckpoint()` and selector `[76, 247, 117, 155]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "cacheCheckpoint", abi = "cacheCheckpoint()")]
    pub struct CacheCheckpointCall;
    #[doc = "Container type for all input parameters for the `cachedCheckpoints` function with signature `cachedCheckpoints(bytes32)` and selector `[228, 113, 102, 71]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "cachedCheckpoints", abi = "cachedCheckpoints(bytes32)")]
    pub struct CachedCheckpointsCall(pub [u8; 32]);
    #[doc = "Container type for all input parameters for the `count` function with signature `count()` and selector `[6, 102, 26, 189]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "count", abi = "count()")]
    pub struct CountCall;
    #[doc = "Container type for all input parameters for the `dispatch` function with signature `dispatch(uint32,bytes32,bytes)` and selector `[250, 49, 222, 1]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "dispatch", abi = "dispatch(uint32,bytes32,bytes)")]
    pub struct DispatchCall {
        pub destination_domain: u32,
        pub recipient_address: [u8; 32],
        pub message_body: ethers::core::types::Bytes,
    }
    #[doc = "Container type for all input parameters for the `fail` function with signature `fail()` and selector `[169, 204, 71, 24]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "fail", abi = "fail()")]
    pub struct FailCall;
    #[doc = "Container type for all input parameters for the `initialize` function with signature `initialize(address)` and selector `[196, 214, 109, 232]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "initialize", abi = "initialize(address)")]
    pub struct InitializeCall {
        pub validator_manager: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `latestCachedCheckpoint` function with signature `latestCachedCheckpoint()` and selector `[219, 90, 104, 75]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "latestCachedCheckpoint", abi = "latestCachedCheckpoint()")]
    pub struct LatestCachedCheckpointCall;
    #[doc = "Container type for all input parameters for the `latestCachedRoot` function with signature `latestCachedRoot()` and selector `[132, 185, 232, 73]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "latestCachedRoot", abi = "latestCachedRoot()")]
    pub struct LatestCachedRootCall;
    #[doc = "Container type for all input parameters for the `latestCheckpoint` function with signature `latestCheckpoint()` and selector `[144, 124, 15, 146]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "latestCheckpoint", abi = "latestCheckpoint()")]
    pub struct LatestCheckpointCall;
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
    #[doc = "Container type for all input parameters for the `root` function with signature `root()` and selector `[235, 240, 199, 23]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "root", abi = "root()")]
    pub struct RootCall;
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
    #[doc = "Container type for all input parameters for the `state` function with signature `state()` and selector `[193, 157, 147, 251]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "state", abi = "state()")]
    pub struct StateCall;
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
    #[doc = "Container type for all input parameters for the `tree` function with signature `tree()` and selector `[253, 84, 178, 40]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "tree", abi = "tree()")]
    pub struct TreeCall;
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
    pub enum OutboxCalls {
        MaxMessageBodyBytes(MaxMessageBodyBytesCall),
        Version(VersionCall),
        CacheCheckpoint(CacheCheckpointCall),
        CachedCheckpoints(CachedCheckpointsCall),
        Count(CountCall),
        Dispatch(DispatchCall),
        Fail(FailCall),
        Initialize(InitializeCall),
        LatestCachedCheckpoint(LatestCachedCheckpointCall),
        LatestCachedRoot(LatestCachedRootCall),
        LatestCheckpoint(LatestCheckpointCall),
        LocalDomain(LocalDomainCall),
        Owner(OwnerCall),
        RenounceOwnership(RenounceOwnershipCall),
        Root(RootCall),
        SetValidatorManager(SetValidatorManagerCall),
        State(StateCall),
        TransferOwnership(TransferOwnershipCall),
        Tree(TreeCall),
        ValidatorManager(ValidatorManagerCall),
    }
    impl ethers::core::abi::AbiDecode for OutboxCalls {
        fn decode(
            data: impl AsRef<[u8]>,
        ) -> ::std::result::Result<Self, ethers::core::abi::AbiError> {
            if let Ok(decoded) =
                <MaxMessageBodyBytesCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::MaxMessageBodyBytes(decoded));
            }
            if let Ok(decoded) =
                <VersionCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::Version(decoded));
            }
            if let Ok(decoded) =
                <CacheCheckpointCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::CacheCheckpoint(decoded));
            }
            if let Ok(decoded) =
                <CachedCheckpointsCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::CachedCheckpoints(decoded));
            }
            if let Ok(decoded) = <CountCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::Count(decoded));
            }
            if let Ok(decoded) =
                <DispatchCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::Dispatch(decoded));
            }
            if let Ok(decoded) = <FailCall as ethers::core::abi::AbiDecode>::decode(data.as_ref()) {
                return Ok(OutboxCalls::Fail(decoded));
            }
            if let Ok(decoded) =
                <InitializeCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::Initialize(decoded));
            }
            if let Ok(decoded) =
                <LatestCachedCheckpointCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::LatestCachedCheckpoint(decoded));
            }
            if let Ok(decoded) =
                <LatestCachedRootCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::LatestCachedRoot(decoded));
            }
            if let Ok(decoded) =
                <LatestCheckpointCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::LatestCheckpoint(decoded));
            }
            if let Ok(decoded) =
                <LocalDomainCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::LocalDomain(decoded));
            }
            if let Ok(decoded) = <OwnerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::Owner(decoded));
            }
            if let Ok(decoded) =
                <RenounceOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::RenounceOwnership(decoded));
            }
            if let Ok(decoded) = <RootCall as ethers::core::abi::AbiDecode>::decode(data.as_ref()) {
                return Ok(OutboxCalls::Root(decoded));
            }
            if let Ok(decoded) =
                <SetValidatorManagerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::SetValidatorManager(decoded));
            }
            if let Ok(decoded) = <StateCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::State(decoded));
            }
            if let Ok(decoded) =
                <TransferOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::TransferOwnership(decoded));
            }
            if let Ok(decoded) = <TreeCall as ethers::core::abi::AbiDecode>::decode(data.as_ref()) {
                return Ok(OutboxCalls::Tree(decoded));
            }
            if let Ok(decoded) =
                <ValidatorManagerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(OutboxCalls::ValidatorManager(decoded));
            }
            Err(ethers::core::abi::Error::InvalidData.into())
        }
    }
    impl ethers::core::abi::AbiEncode for OutboxCalls {
        fn encode(self) -> Vec<u8> {
            match self {
                OutboxCalls::MaxMessageBodyBytes(element) => element.encode(),
                OutboxCalls::Version(element) => element.encode(),
                OutboxCalls::CacheCheckpoint(element) => element.encode(),
                OutboxCalls::CachedCheckpoints(element) => element.encode(),
                OutboxCalls::Count(element) => element.encode(),
                OutboxCalls::Dispatch(element) => element.encode(),
                OutboxCalls::Fail(element) => element.encode(),
                OutboxCalls::Initialize(element) => element.encode(),
                OutboxCalls::LatestCachedCheckpoint(element) => element.encode(),
                OutboxCalls::LatestCachedRoot(element) => element.encode(),
                OutboxCalls::LatestCheckpoint(element) => element.encode(),
                OutboxCalls::LocalDomain(element) => element.encode(),
                OutboxCalls::Owner(element) => element.encode(),
                OutboxCalls::RenounceOwnership(element) => element.encode(),
                OutboxCalls::Root(element) => element.encode(),
                OutboxCalls::SetValidatorManager(element) => element.encode(),
                OutboxCalls::State(element) => element.encode(),
                OutboxCalls::TransferOwnership(element) => element.encode(),
                OutboxCalls::Tree(element) => element.encode(),
                OutboxCalls::ValidatorManager(element) => element.encode(),
            }
        }
    }
    impl ::std::fmt::Display for OutboxCalls {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                OutboxCalls::MaxMessageBodyBytes(element) => element.fmt(f),
                OutboxCalls::Version(element) => element.fmt(f),
                OutboxCalls::CacheCheckpoint(element) => element.fmt(f),
                OutboxCalls::CachedCheckpoints(element) => element.fmt(f),
                OutboxCalls::Count(element) => element.fmt(f),
                OutboxCalls::Dispatch(element) => element.fmt(f),
                OutboxCalls::Fail(element) => element.fmt(f),
                OutboxCalls::Initialize(element) => element.fmt(f),
                OutboxCalls::LatestCachedCheckpoint(element) => element.fmt(f),
                OutboxCalls::LatestCachedRoot(element) => element.fmt(f),
                OutboxCalls::LatestCheckpoint(element) => element.fmt(f),
                OutboxCalls::LocalDomain(element) => element.fmt(f),
                OutboxCalls::Owner(element) => element.fmt(f),
                OutboxCalls::RenounceOwnership(element) => element.fmt(f),
                OutboxCalls::Root(element) => element.fmt(f),
                OutboxCalls::SetValidatorManager(element) => element.fmt(f),
                OutboxCalls::State(element) => element.fmt(f),
                OutboxCalls::TransferOwnership(element) => element.fmt(f),
                OutboxCalls::Tree(element) => element.fmt(f),
                OutboxCalls::ValidatorManager(element) => element.fmt(f),
            }
        }
    }
    impl ::std::convert::From<MaxMessageBodyBytesCall> for OutboxCalls {
        fn from(var: MaxMessageBodyBytesCall) -> Self {
            OutboxCalls::MaxMessageBodyBytes(var)
        }
    }
    impl ::std::convert::From<VersionCall> for OutboxCalls {
        fn from(var: VersionCall) -> Self {
            OutboxCalls::Version(var)
        }
    }
    impl ::std::convert::From<CacheCheckpointCall> for OutboxCalls {
        fn from(var: CacheCheckpointCall) -> Self {
            OutboxCalls::CacheCheckpoint(var)
        }
    }
    impl ::std::convert::From<CachedCheckpointsCall> for OutboxCalls {
        fn from(var: CachedCheckpointsCall) -> Self {
            OutboxCalls::CachedCheckpoints(var)
        }
    }
    impl ::std::convert::From<CountCall> for OutboxCalls {
        fn from(var: CountCall) -> Self {
            OutboxCalls::Count(var)
        }
    }
    impl ::std::convert::From<DispatchCall> for OutboxCalls {
        fn from(var: DispatchCall) -> Self {
            OutboxCalls::Dispatch(var)
        }
    }
    impl ::std::convert::From<FailCall> for OutboxCalls {
        fn from(var: FailCall) -> Self {
            OutboxCalls::Fail(var)
        }
    }
    impl ::std::convert::From<InitializeCall> for OutboxCalls {
        fn from(var: InitializeCall) -> Self {
            OutboxCalls::Initialize(var)
        }
    }
    impl ::std::convert::From<LatestCachedCheckpointCall> for OutboxCalls {
        fn from(var: LatestCachedCheckpointCall) -> Self {
            OutboxCalls::LatestCachedCheckpoint(var)
        }
    }
    impl ::std::convert::From<LatestCachedRootCall> for OutboxCalls {
        fn from(var: LatestCachedRootCall) -> Self {
            OutboxCalls::LatestCachedRoot(var)
        }
    }
    impl ::std::convert::From<LatestCheckpointCall> for OutboxCalls {
        fn from(var: LatestCheckpointCall) -> Self {
            OutboxCalls::LatestCheckpoint(var)
        }
    }
    impl ::std::convert::From<LocalDomainCall> for OutboxCalls {
        fn from(var: LocalDomainCall) -> Self {
            OutboxCalls::LocalDomain(var)
        }
    }
    impl ::std::convert::From<OwnerCall> for OutboxCalls {
        fn from(var: OwnerCall) -> Self {
            OutboxCalls::Owner(var)
        }
    }
    impl ::std::convert::From<RenounceOwnershipCall> for OutboxCalls {
        fn from(var: RenounceOwnershipCall) -> Self {
            OutboxCalls::RenounceOwnership(var)
        }
    }
    impl ::std::convert::From<RootCall> for OutboxCalls {
        fn from(var: RootCall) -> Self {
            OutboxCalls::Root(var)
        }
    }
    impl ::std::convert::From<SetValidatorManagerCall> for OutboxCalls {
        fn from(var: SetValidatorManagerCall) -> Self {
            OutboxCalls::SetValidatorManager(var)
        }
    }
    impl ::std::convert::From<StateCall> for OutboxCalls {
        fn from(var: StateCall) -> Self {
            OutboxCalls::State(var)
        }
    }
    impl ::std::convert::From<TransferOwnershipCall> for OutboxCalls {
        fn from(var: TransferOwnershipCall) -> Self {
            OutboxCalls::TransferOwnership(var)
        }
    }
    impl ::std::convert::From<TreeCall> for OutboxCalls {
        fn from(var: TreeCall) -> Self {
            OutboxCalls::Tree(var)
        }
    }
    impl ::std::convert::From<ValidatorManagerCall> for OutboxCalls {
        fn from(var: ValidatorManagerCall) -> Self {
            OutboxCalls::ValidatorManager(var)
        }
    }
    #[doc = "Container type for all return fields from the `MAX_MESSAGE_BODY_BYTES` function with signature `MAX_MESSAGE_BODY_BYTES()` and selector `[82, 42, 224, 2]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct MaxMessageBodyBytesReturn(pub ethers::core::types::U256);
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
    #[doc = "Container type for all return fields from the `cachedCheckpoints` function with signature `cachedCheckpoints(bytes32)` and selector `[228, 113, 102, 71]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct CachedCheckpointsReturn(pub ethers::core::types::U256);
    #[doc = "Container type for all return fields from the `count` function with signature `count()` and selector `[6, 102, 26, 189]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct CountReturn(pub ethers::core::types::U256);
    #[doc = "Container type for all return fields from the `dispatch` function with signature `dispatch(uint32,bytes32,bytes)` and selector `[250, 49, 222, 1]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct DispatchReturn(pub ethers::core::types::U256);
    #[doc = "Container type for all return fields from the `latestCachedCheckpoint` function with signature `latestCachedCheckpoint()` and selector `[219, 90, 104, 75]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct LatestCachedCheckpointReturn {
        pub root: [u8; 32],
        pub index: ethers::core::types::U256,
    }
    #[doc = "Container type for all return fields from the `latestCachedRoot` function with signature `latestCachedRoot()` and selector `[132, 185, 232, 73]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct LatestCachedRootReturn(pub [u8; 32]);
    #[doc = "Container type for all return fields from the `latestCheckpoint` function with signature `latestCheckpoint()` and selector `[144, 124, 15, 146]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct LatestCheckpointReturn(pub [u8; 32], pub ethers::core::types::U256);
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
    #[doc = "Container type for all return fields from the `root` function with signature `root()` and selector `[235, 240, 199, 23]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct RootReturn(pub [u8; 32]);
    #[doc = "Container type for all return fields from the `state` function with signature `state()` and selector `[193, 157, 147, 251]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct StateReturn(pub u8);
    #[doc = "Container type for all return fields from the `tree` function with signature `tree()` and selector `[253, 84, 178, 40]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct TreeReturn {
        pub count: ethers::core::types::U256,
    }
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
