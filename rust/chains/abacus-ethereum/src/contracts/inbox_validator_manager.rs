pub use inbox_validator_manager::*;
#[allow(clippy::too_many_arguments, non_camel_case_types)]
pub mod inbox_validator_manager {
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
    #[doc = "InboxValidatorManager was auto-generated with ethers-rs Abigen. More information at: https://github.com/gakonst/ethers-rs"]
    use std::sync::Arc;
    # [rustfmt :: skip] const __ABI : & str = "[\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"_remoteDomain\",\n        \"type\": \"uint32\"\n      },\n      {\n        \"internalType\": \"address[]\",\n        \"name\": \"_validators\",\n        \"type\": \"address[]\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_threshold\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"constructor\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"previousOwner\",\n        \"type\": \"address\"\n      },\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"OwnershipTransferred\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": false,\n        \"internalType\": \"uint256\",\n        \"name\": \"threshold\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"ThresholdSet\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"validator\",\n        \"type\": \"address\"\n      },\n      {\n        \"indexed\": false,\n        \"internalType\": \"uint256\",\n        \"name\": \"validatorCount\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"ValidatorEnrolled\",\n    \"type\": \"event\"\n  },\n  {\n    \"anonymous\": false,\n    \"inputs\": [\n      {\n        \"indexed\": true,\n        \"internalType\": \"address\",\n        \"name\": \"validator\",\n        \"type\": \"address\"\n      },\n      {\n        \"indexed\": false,\n        \"internalType\": \"uint256\",\n        \"name\": \"validatorCount\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"ValidatorUnenrolled\",\n    \"type\": \"event\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"domain\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint32\",\n        \"name\": \"\",\n        \"type\": \"uint32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"domainHash\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"\",\n        \"type\": \"bytes32\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validator\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"enrollValidator\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"_root\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_index\",\n        \"type\": \"uint256\"\n      },\n      {\n        \"internalType\": \"bytes[]\",\n        \"name\": \"_signatures\",\n        \"type\": \"bytes[]\"\n      }\n    ],\n    \"name\": \"isQuorum\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bool\",\n        \"name\": \"\",\n        \"type\": \"bool\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validator\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"isValidator\",\n    \"outputs\": [\n      {\n        \"internalType\": \"bool\",\n        \"name\": \"\",\n        \"type\": \"bool\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"owner\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"\",\n        \"type\": \"address\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"contract IInbox\",\n        \"name\": \"_inbox\",\n        \"type\": \"address\"\n      },\n      {\n        \"internalType\": \"bytes32\",\n        \"name\": \"_root\",\n        \"type\": \"bytes32\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_index\",\n        \"type\": \"uint256\"\n      },\n      {\n        \"internalType\": \"bytes[]\",\n        \"name\": \"_signatures\",\n        \"type\": \"bytes[]\"\n      },\n      {\n        \"internalType\": \"bytes\",\n        \"name\": \"_message\",\n        \"type\": \"bytes\"\n      },\n      {\n        \"internalType\": \"bytes32[32]\",\n        \"name\": \"_proof\",\n        \"type\": \"bytes32[32]\"\n      },\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_leafIndex\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"process\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"renounceOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"_threshold\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"name\": \"setThreshold\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"threshold\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"newOwner\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"transferOwnership\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [\n      {\n        \"internalType\": \"address\",\n        \"name\": \"_validator\",\n        \"type\": \"address\"\n      }\n    ],\n    \"name\": \"unenrollValidator\",\n    \"outputs\": [],\n    \"stateMutability\": \"nonpayable\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"validatorCount\",\n    \"outputs\": [\n      {\n        \"internalType\": \"uint256\",\n        \"name\": \"\",\n        \"type\": \"uint256\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  },\n  {\n    \"inputs\": [],\n    \"name\": \"validators\",\n    \"outputs\": [\n      {\n        \"internalType\": \"address[]\",\n        \"name\": \"\",\n        \"type\": \"address[]\"\n      }\n    ],\n    \"stateMutability\": \"view\",\n    \"type\": \"function\"\n  }\n]\n" ;
    #[doc = r" The parsed JSON-ABI of the contract."]
    pub static INBOXVALIDATORMANAGER_ABI: ethers::contract::Lazy<ethers::core::abi::Abi> =
        ethers::contract::Lazy::new(|| {
            ethers::core::utils::__serde_json::from_str(__ABI).expect("invalid abi")
        });
    pub struct InboxValidatorManager<M>(ethers::contract::Contract<M>);
    impl<M> Clone for InboxValidatorManager<M> {
        fn clone(&self) -> Self {
            InboxValidatorManager(self.0.clone())
        }
    }
    impl<M> std::ops::Deref for InboxValidatorManager<M> {
        type Target = ethers::contract::Contract<M>;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl<M> std::fmt::Debug for InboxValidatorManager<M> {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.debug_tuple(stringify!(InboxValidatorManager))
                .field(&self.address())
                .finish()
        }
    }
    impl<M: ethers::providers::Middleware> InboxValidatorManager<M> {
        #[doc = r" Creates a new contract instance with the specified `ethers`"]
        #[doc = r" client at the given `Address`. The contract derefs to a `ethers::Contract`"]
        #[doc = r" object"]
        pub fn new<T: Into<ethers::core::types::Address>>(
            address: T,
            client: ::std::sync::Arc<M>,
        ) -> Self {
            ethers::contract::Contract::new(
                address.into(),
                INBOXVALIDATORMANAGER_ABI.clone(),
                client,
            )
            .into()
        }
        #[doc = "Calls the contract's `domain` (0xc2fb26a6) function"]
        pub fn domain(&self) -> ethers::contract::builders::ContractCall<M, u32> {
            self.0
                .method_hash([194, 251, 38, 166], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `domainHash` (0xdfe86ac5) function"]
        pub fn domain_hash(&self) -> ethers::contract::builders::ContractCall<M, [u8; 32]> {
            self.0
                .method_hash([223, 232, 106, 197], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `enrollValidator` (0xbc3fd543) function"]
        pub fn enroll_validator(
            &self,
            validator: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([188, 63, 213, 67], validator)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `isQuorum` (0xb9eb0608) function"]
        pub fn is_quorum(
            &self,
            root: [u8; 32],
            index: ethers::core::types::U256,
            signatures: ::std::vec::Vec<ethers::core::types::Bytes>,
        ) -> ethers::contract::builders::ContractCall<M, bool> {
            self.0
                .method_hash([185, 235, 6, 8], (root, index, signatures))
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `isValidator` (0xfacd743b) function"]
        pub fn is_validator(
            &self,
            validator: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, bool> {
            self.0
                .method_hash([250, 205, 116, 59], validator)
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
        #[doc = "Calls the contract's `process` (0x47141916) function"]
        pub fn process(
            &self,
            inbox: ethers::core::types::Address,
            root: [u8; 32],
            index: ethers::core::types::U256,
            signatures: ::std::vec::Vec<ethers::core::types::Bytes>,
            message: ethers::core::types::Bytes,
            proof: [[u8; 32]; 32usize],
            leaf_index: ethers::core::types::U256,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash(
                    [71, 20, 25, 22],
                    (inbox, root, index, signatures, message, proof, leaf_index),
                )
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `renounceOwnership` (0x715018a6) function"]
        pub fn renounce_ownership(&self) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([113, 80, 24, 166], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `setThreshold` (0x960bfe04) function"]
        pub fn set_threshold(
            &self,
            threshold: ethers::core::types::U256,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([150, 11, 254, 4], threshold)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `threshold` (0x42cde4e8) function"]
        pub fn threshold(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([66, 205, 228, 232], ())
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
        #[doc = "Calls the contract's `unenrollValidator` (0xd9426bda) function"]
        pub fn unenroll_validator(
            &self,
            validator: ethers::core::types::Address,
        ) -> ethers::contract::builders::ContractCall<M, ()> {
            self.0
                .method_hash([217, 66, 107, 218], validator)
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `validatorCount` (0x0f43a677) function"]
        pub fn validator_count(
            &self,
        ) -> ethers::contract::builders::ContractCall<M, ethers::core::types::U256> {
            self.0
                .method_hash([15, 67, 166, 119], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `validators` (0xca1e7819) function"]
        pub fn validators(
            &self,
        ) -> ethers::contract::builders::ContractCall<
            M,
            ::std::vec::Vec<ethers::core::types::Address>,
        > {
            self.0
                .method_hash([202, 30, 120, 25], ())
                .expect("method not found (this should never happen)")
        }
        #[doc = "Gets the contract's `OwnershipTransferred` event"]
        pub fn ownership_transferred_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, OwnershipTransferredFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `ThresholdSet` event"]
        pub fn threshold_set_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, ThresholdSetFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `ValidatorEnrolled` event"]
        pub fn validator_enrolled_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, ValidatorEnrolledFilter> {
            self.0.event()
        }
        #[doc = "Gets the contract's `ValidatorUnenrolled` event"]
        pub fn validator_unenrolled_filter(
            &self,
        ) -> ethers::contract::builders::Event<M, ValidatorUnenrolledFilter> {
            self.0.event()
        }
        #[doc = r" Returns an [`Event`](#ethers_contract::builders::Event) builder for all events of this contract"]
        pub fn events(&self) -> ethers::contract::builders::Event<M, InboxValidatorManagerEvents> {
            self.0.event_with_filter(Default::default())
        }
    }
    impl<M: ethers::providers::Middleware> From<ethers::contract::Contract<M>>
        for InboxValidatorManager<M>
    {
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
    #[ethevent(name = "ThresholdSet", abi = "ThresholdSet(uint256)")]
    pub struct ThresholdSetFilter {
        pub threshold: ethers::core::types::U256,
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
    #[ethevent(name = "ValidatorEnrolled", abi = "ValidatorEnrolled(address,uint256)")]
    pub struct ValidatorEnrolledFilter {
        #[ethevent(indexed)]
        pub validator: ethers::core::types::Address,
        pub validator_count: ethers::core::types::U256,
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
        name = "ValidatorUnenrolled",
        abi = "ValidatorUnenrolled(address,uint256)"
    )]
    pub struct ValidatorUnenrolledFilter {
        #[ethevent(indexed)]
        pub validator: ethers::core::types::Address,
        pub validator_count: ethers::core::types::U256,
    }
    #[derive(Debug, Clone, PartialEq, Eq, ethers :: contract :: EthAbiType)]
    pub enum InboxValidatorManagerEvents {
        OwnershipTransferredFilter(OwnershipTransferredFilter),
        ThresholdSetFilter(ThresholdSetFilter),
        ValidatorEnrolledFilter(ValidatorEnrolledFilter),
        ValidatorUnenrolledFilter(ValidatorUnenrolledFilter),
    }
    impl ethers::contract::EthLogDecode for InboxValidatorManagerEvents {
        fn decode_log(
            log: &ethers::core::abi::RawLog,
        ) -> ::std::result::Result<Self, ethers::core::abi::Error>
        where
            Self: Sized,
        {
            if let Ok(decoded) = OwnershipTransferredFilter::decode_log(log) {
                return Ok(InboxValidatorManagerEvents::OwnershipTransferredFilter(
                    decoded,
                ));
            }
            if let Ok(decoded) = ThresholdSetFilter::decode_log(log) {
                return Ok(InboxValidatorManagerEvents::ThresholdSetFilter(decoded));
            }
            if let Ok(decoded) = ValidatorEnrolledFilter::decode_log(log) {
                return Ok(InboxValidatorManagerEvents::ValidatorEnrolledFilter(
                    decoded,
                ));
            }
            if let Ok(decoded) = ValidatorUnenrolledFilter::decode_log(log) {
                return Ok(InboxValidatorManagerEvents::ValidatorUnenrolledFilter(
                    decoded,
                ));
            }
            Err(ethers::core::abi::Error::InvalidData)
        }
    }
    impl ::std::fmt::Display for InboxValidatorManagerEvents {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                InboxValidatorManagerEvents::OwnershipTransferredFilter(element) => element.fmt(f),
                InboxValidatorManagerEvents::ThresholdSetFilter(element) => element.fmt(f),
                InboxValidatorManagerEvents::ValidatorEnrolledFilter(element) => element.fmt(f),
                InboxValidatorManagerEvents::ValidatorUnenrolledFilter(element) => element.fmt(f),
            }
        }
    }
    #[doc = "Container type for all input parameters for the `domain` function with signature `domain()` and selector `[194, 251, 38, 166]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "domain", abi = "domain()")]
    pub struct DomainCall;
    #[doc = "Container type for all input parameters for the `domainHash` function with signature `domainHash()` and selector `[223, 232, 106, 197]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "domainHash", abi = "domainHash()")]
    pub struct DomainHashCall;
    #[doc = "Container type for all input parameters for the `enrollValidator` function with signature `enrollValidator(address)` and selector `[188, 63, 213, 67]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "enrollValidator", abi = "enrollValidator(address)")]
    pub struct EnrollValidatorCall {
        pub validator: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `isQuorum` function with signature `isQuorum(bytes32,uint256,bytes[])` and selector `[185, 235, 6, 8]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "isQuorum", abi = "isQuorum(bytes32,uint256,bytes[])")]
    pub struct IsQuorumCall {
        pub root: [u8; 32],
        pub index: ethers::core::types::U256,
        pub signatures: ::std::vec::Vec<ethers::core::types::Bytes>,
    }
    #[doc = "Container type for all input parameters for the `isValidator` function with signature `isValidator(address)` and selector `[250, 205, 116, 59]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "isValidator", abi = "isValidator(address)")]
    pub struct IsValidatorCall {
        pub validator: ethers::core::types::Address,
    }
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
    #[doc = "Container type for all input parameters for the `process` function with signature `process(address,bytes32,uint256,bytes[],bytes,bytes32[32],uint256)` and selector `[71, 20, 25, 22]`"]
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
        abi = "process(address,bytes32,uint256,bytes[],bytes,bytes32[32],uint256)"
    )]
    pub struct ProcessCall {
        pub inbox: ethers::core::types::Address,
        pub root: [u8; 32],
        pub index: ethers::core::types::U256,
        pub signatures: ::std::vec::Vec<ethers::core::types::Bytes>,
        pub message: ethers::core::types::Bytes,
        pub proof: [[u8; 32]; 32usize],
        pub leaf_index: ethers::core::types::U256,
    }
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
    #[doc = "Container type for all input parameters for the `setThreshold` function with signature `setThreshold(uint256)` and selector `[150, 11, 254, 4]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "setThreshold", abi = "setThreshold(uint256)")]
    pub struct SetThresholdCall {
        pub threshold: ethers::core::types::U256,
    }
    #[doc = "Container type for all input parameters for the `threshold` function with signature `threshold()` and selector `[66, 205, 228, 232]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "threshold", abi = "threshold()")]
    pub struct ThresholdCall;
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
    #[doc = "Container type for all input parameters for the `unenrollValidator` function with signature `unenrollValidator(address)` and selector `[217, 66, 107, 218]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "unenrollValidator", abi = "unenrollValidator(address)")]
    pub struct UnenrollValidatorCall {
        pub validator: ethers::core::types::Address,
    }
    #[doc = "Container type for all input parameters for the `validatorCount` function with signature `validatorCount()` and selector `[15, 67, 166, 119]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "validatorCount", abi = "validatorCount()")]
    pub struct ValidatorCountCall;
    #[doc = "Container type for all input parameters for the `validators` function with signature `validators()` and selector `[202, 30, 120, 25]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthCall,
        ethers :: contract :: EthDisplay,
        Default,
    )]
    #[ethcall(name = "validators", abi = "validators()")]
    pub struct ValidatorsCall;
    #[derive(Debug, Clone, PartialEq, Eq, ethers :: contract :: EthAbiType)]
    pub enum InboxValidatorManagerCalls {
        Domain(DomainCall),
        DomainHash(DomainHashCall),
        EnrollValidator(EnrollValidatorCall),
        IsQuorum(IsQuorumCall),
        IsValidator(IsValidatorCall),
        Owner(OwnerCall),
        Process(ProcessCall),
        RenounceOwnership(RenounceOwnershipCall),
        SetThreshold(SetThresholdCall),
        Threshold(ThresholdCall),
        TransferOwnership(TransferOwnershipCall),
        UnenrollValidator(UnenrollValidatorCall),
        ValidatorCount(ValidatorCountCall),
        Validators(ValidatorsCall),
    }
    impl ethers::core::abi::AbiDecode for InboxValidatorManagerCalls {
        fn decode(
            data: impl AsRef<[u8]>,
        ) -> ::std::result::Result<Self, ethers::core::abi::AbiError> {
            if let Ok(decoded) = <DomainCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::Domain(decoded));
            }
            if let Ok(decoded) =
                <DomainHashCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::DomainHash(decoded));
            }
            if let Ok(decoded) =
                <EnrollValidatorCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::EnrollValidator(decoded));
            }
            if let Ok(decoded) =
                <IsQuorumCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::IsQuorum(decoded));
            }
            if let Ok(decoded) =
                <IsValidatorCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::IsValidator(decoded));
            }
            if let Ok(decoded) = <OwnerCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::Owner(decoded));
            }
            if let Ok(decoded) =
                <ProcessCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::Process(decoded));
            }
            if let Ok(decoded) =
                <RenounceOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::RenounceOwnership(decoded));
            }
            if let Ok(decoded) =
                <SetThresholdCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::SetThreshold(decoded));
            }
            if let Ok(decoded) =
                <ThresholdCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::Threshold(decoded));
            }
            if let Ok(decoded) =
                <TransferOwnershipCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::TransferOwnership(decoded));
            }
            if let Ok(decoded) =
                <UnenrollValidatorCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::UnenrollValidator(decoded));
            }
            if let Ok(decoded) =
                <ValidatorCountCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::ValidatorCount(decoded));
            }
            if let Ok(decoded) =
                <ValidatorsCall as ethers::core::abi::AbiDecode>::decode(data.as_ref())
            {
                return Ok(InboxValidatorManagerCalls::Validators(decoded));
            }
            Err(ethers::core::abi::Error::InvalidData.into())
        }
    }
    impl ethers::core::abi::AbiEncode for InboxValidatorManagerCalls {
        fn encode(self) -> Vec<u8> {
            match self {
                InboxValidatorManagerCalls::Domain(element) => element.encode(),
                InboxValidatorManagerCalls::DomainHash(element) => element.encode(),
                InboxValidatorManagerCalls::EnrollValidator(element) => element.encode(),
                InboxValidatorManagerCalls::IsQuorum(element) => element.encode(),
                InboxValidatorManagerCalls::IsValidator(element) => element.encode(),
                InboxValidatorManagerCalls::Owner(element) => element.encode(),
                InboxValidatorManagerCalls::Process(element) => element.encode(),
                InboxValidatorManagerCalls::RenounceOwnership(element) => element.encode(),
                InboxValidatorManagerCalls::SetThreshold(element) => element.encode(),
                InboxValidatorManagerCalls::Threshold(element) => element.encode(),
                InboxValidatorManagerCalls::TransferOwnership(element) => element.encode(),
                InboxValidatorManagerCalls::UnenrollValidator(element) => element.encode(),
                InboxValidatorManagerCalls::ValidatorCount(element) => element.encode(),
                InboxValidatorManagerCalls::Validators(element) => element.encode(),
            }
        }
    }
    impl ::std::fmt::Display for InboxValidatorManagerCalls {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
            match self {
                InboxValidatorManagerCalls::Domain(element) => element.fmt(f),
                InboxValidatorManagerCalls::DomainHash(element) => element.fmt(f),
                InboxValidatorManagerCalls::EnrollValidator(element) => element.fmt(f),
                InboxValidatorManagerCalls::IsQuorum(element) => element.fmt(f),
                InboxValidatorManagerCalls::IsValidator(element) => element.fmt(f),
                InboxValidatorManagerCalls::Owner(element) => element.fmt(f),
                InboxValidatorManagerCalls::Process(element) => element.fmt(f),
                InboxValidatorManagerCalls::RenounceOwnership(element) => element.fmt(f),
                InboxValidatorManagerCalls::SetThreshold(element) => element.fmt(f),
                InboxValidatorManagerCalls::Threshold(element) => element.fmt(f),
                InboxValidatorManagerCalls::TransferOwnership(element) => element.fmt(f),
                InboxValidatorManagerCalls::UnenrollValidator(element) => element.fmt(f),
                InboxValidatorManagerCalls::ValidatorCount(element) => element.fmt(f),
                InboxValidatorManagerCalls::Validators(element) => element.fmt(f),
            }
        }
    }
    impl ::std::convert::From<DomainCall> for InboxValidatorManagerCalls {
        fn from(var: DomainCall) -> Self {
            InboxValidatorManagerCalls::Domain(var)
        }
    }
    impl ::std::convert::From<DomainHashCall> for InboxValidatorManagerCalls {
        fn from(var: DomainHashCall) -> Self {
            InboxValidatorManagerCalls::DomainHash(var)
        }
    }
    impl ::std::convert::From<EnrollValidatorCall> for InboxValidatorManagerCalls {
        fn from(var: EnrollValidatorCall) -> Self {
            InboxValidatorManagerCalls::EnrollValidator(var)
        }
    }
    impl ::std::convert::From<IsQuorumCall> for InboxValidatorManagerCalls {
        fn from(var: IsQuorumCall) -> Self {
            InboxValidatorManagerCalls::IsQuorum(var)
        }
    }
    impl ::std::convert::From<IsValidatorCall> for InboxValidatorManagerCalls {
        fn from(var: IsValidatorCall) -> Self {
            InboxValidatorManagerCalls::IsValidator(var)
        }
    }
    impl ::std::convert::From<OwnerCall> for InboxValidatorManagerCalls {
        fn from(var: OwnerCall) -> Self {
            InboxValidatorManagerCalls::Owner(var)
        }
    }
    impl ::std::convert::From<ProcessCall> for InboxValidatorManagerCalls {
        fn from(var: ProcessCall) -> Self {
            InboxValidatorManagerCalls::Process(var)
        }
    }
    impl ::std::convert::From<RenounceOwnershipCall> for InboxValidatorManagerCalls {
        fn from(var: RenounceOwnershipCall) -> Self {
            InboxValidatorManagerCalls::RenounceOwnership(var)
        }
    }
    impl ::std::convert::From<SetThresholdCall> for InboxValidatorManagerCalls {
        fn from(var: SetThresholdCall) -> Self {
            InboxValidatorManagerCalls::SetThreshold(var)
        }
    }
    impl ::std::convert::From<ThresholdCall> for InboxValidatorManagerCalls {
        fn from(var: ThresholdCall) -> Self {
            InboxValidatorManagerCalls::Threshold(var)
        }
    }
    impl ::std::convert::From<TransferOwnershipCall> for InboxValidatorManagerCalls {
        fn from(var: TransferOwnershipCall) -> Self {
            InboxValidatorManagerCalls::TransferOwnership(var)
        }
    }
    impl ::std::convert::From<UnenrollValidatorCall> for InboxValidatorManagerCalls {
        fn from(var: UnenrollValidatorCall) -> Self {
            InboxValidatorManagerCalls::UnenrollValidator(var)
        }
    }
    impl ::std::convert::From<ValidatorCountCall> for InboxValidatorManagerCalls {
        fn from(var: ValidatorCountCall) -> Self {
            InboxValidatorManagerCalls::ValidatorCount(var)
        }
    }
    impl ::std::convert::From<ValidatorsCall> for InboxValidatorManagerCalls {
        fn from(var: ValidatorsCall) -> Self {
            InboxValidatorManagerCalls::Validators(var)
        }
    }
    #[doc = "Container type for all return fields from the `domain` function with signature `domain()` and selector `[194, 251, 38, 166]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct DomainReturn(pub u32);
    #[doc = "Container type for all return fields from the `domainHash` function with signature `domainHash()` and selector `[223, 232, 106, 197]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct DomainHashReturn(pub [u8; 32]);
    #[doc = "Container type for all return fields from the `isQuorum` function with signature `isQuorum(bytes32,uint256,bytes[])` and selector `[185, 235, 6, 8]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct IsQuorumReturn(pub bool);
    #[doc = "Container type for all return fields from the `isValidator` function with signature `isValidator(address)` and selector `[250, 205, 116, 59]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct IsValidatorReturn(pub bool);
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
    #[doc = "Container type for all return fields from the `threshold` function with signature `threshold()` and selector `[66, 205, 228, 232]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct ThresholdReturn(pub ethers::core::types::U256);
    #[doc = "Container type for all return fields from the `validatorCount` function with signature `validatorCount()` and selector `[15, 67, 166, 119]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct ValidatorCountReturn(pub ethers::core::types::U256);
    #[doc = "Container type for all return fields from the `validators` function with signature `validators()` and selector `[202, 30, 120, 25]`"]
    #[derive(
        Clone,
        Debug,
        Eq,
        PartialEq,
        ethers :: contract :: EthAbiType,
        ethers :: contract :: EthAbiCodec,
        Default,
    )]
    pub struct ValidatorsReturn(pub ::std::vec::Vec<ethers::core::types::Address>);
}
