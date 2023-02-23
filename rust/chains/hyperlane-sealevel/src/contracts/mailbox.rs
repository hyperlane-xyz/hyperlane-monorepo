pub use mailbox_mod::*;
#[allow(clippy::too_many_arguments)]
pub mod mailbox_mod {
    #![allow(clippy::enum_variant_names)]
    #![allow(dead_code)]
    #![allow(unused_imports)]
    use fuels::contract::contract::{get_decoded_output, Contract, ContractCallHandler};
    use fuels::contract::logs::LogDecoder;
    use fuels::core::abi_decoder::ABIDecoder;
    use fuels::core::code_gen::function_selector::resolve_fn_selector;
    use fuels::core::code_gen::get_logs_hashmap;
    use fuels::core::types::*;
    use fuels::core::{try_from_bytes, Parameterize, Token, Tokenizable};
    use fuels::core::{EnumSelector, Identity, StringToken};
    use fuels::signers::WalletUnlocked;
    use fuels::tx::{Address, ContractId, Receipt};
    use fuels::types::bech32::Bech32ContractId;
    use fuels::types::enum_variants::EnumVariants;
    use fuels::types::errors::Error as SDKError;
    use fuels::types::param_types::ParamType;
    use fuels::types::ResolvedLog;
    use std::collections::{HashMap, HashSet};
    use std::str::FromStr;
    pub struct Mailbox {
        contract_id: Bech32ContractId,
        wallet: WalletUnlocked,
    }
    impl Mailbox {
        pub fn new(contract_id: Bech32ContractId, wallet: WalletUnlocked) -> Self {
            Self {
                contract_id,
                wallet,
            }
        }
        pub fn get_contract_id(&self) -> &Bech32ContractId {
            &self.contract_id
        }
        pub fn get_wallet(&self) -> WalletUnlocked {
            self.wallet.clone()
        }
        pub fn with_wallet(&self, mut wallet: WalletUnlocked) -> Result<Self, SDKError> {
            let provider = self.wallet.get_provider()?;
            wallet.set_provider(provider.clone());
            Ok(Self {
                contract_id: self.contract_id.clone(),
                wallet: wallet,
            })
        }
        pub async fn get_balances(&self) -> Result<HashMap<String, u64>, SDKError> {
            self.wallet
                .get_provider()?
                .get_contract_balances(&self.contract_id)
                .await
                .map_err(Into::into)
        }
        pub fn methods(&self) -> MailboxMethods {
            MailboxMethods {
                contract_id: self.contract_id.clone(),
                wallet: self.wallet.clone(),
                logs_map: get_logs_hashmap(
                    &[
                        (0u64, SizedAsciiString::<12usize>::param_type()),
                        (1u64, SizedAsciiString::<16usize>::param_type()),
                        (2u64, SizedAsciiString::<8usize>::param_type()),
                        (3u64, SizedAsciiString::<12usize>::param_type()),
                        (4u64, SizedAsciiString::<9usize>::param_type()),
                        (5u64, SizedAsciiString::<7usize>::param_type()),
                        (6u64, <Bits256>::param_type()),
                        (7u64, SizedAsciiString::<6usize>::param_type()),
                        (8u64, SizedAsciiString::<6usize>::param_type()),
                        (9u64, <OwnershipTransferredEvent>::param_type()),
                    ],
                    Some(self.contract_id.clone()),
                ),
            }
        }
    }
    pub struct MailboxMethods {
        contract_id: Bech32ContractId,
        wallet: WalletUnlocked,
        logs_map: HashMap<(Bech32ContractId, u64), ParamType>,
    }
    impl MailboxMethods {
        #[doc = "Calls the contract's `count` function"]
        pub fn count(&self) -> ContractCallHandler<u32> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("count", &[]);
            let tokens = [];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `delivered` function"]
        pub fn delivered(&self, message_id: Bits256) -> ContractCallHandler<bool> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("delivered", &[<Bits256>::param_type()]);
            let tokens = [message_id.into_token()];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `dispatch` function"]
        pub fn dispatch(
            &self,
            destination_domain: u32,
            recipient: Bits256,
            message_body: Vec<u8>,
        ) -> ContractCallHandler<Bits256> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector(
                "dispatch",
                &[
                    <u32>::param_type(),
                    <Bits256>::param_type(),
                    Vec::<u8>::param_type(),
                ],
            );
            let tokens = [
                destination_domain.into_token(),
                recipient.into_token(),
                message_body.into_token(),
            ];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `get_default_ism` function"]
        pub fn get_default_ism(&self) -> ContractCallHandler<ContractId> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("get_default_ism", &[]);
            let tokens = [];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `latest_checkpoint` function"]
        pub fn latest_checkpoint(&self) -> ContractCallHandler<(Bits256, u32)> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("latest_checkpoint", &[]);
            let tokens = [];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `process` function"]
        pub fn process(&self, metadata: Vec<u8>, message: Message) -> ContractCallHandler<()> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector(
                "process",
                &[Vec::<u8>::param_type(), <Message>::param_type()],
            );
            let tokens = [metadata.into_token(), message.into_token()];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `root` function"]
        pub fn root(&self) -> ContractCallHandler<Bits256> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("root", &[]);
            let tokens = [];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `set_default_ism` function"]
        pub fn set_default_ism(&self, module: ContractId) -> ContractCallHandler<()> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector =
                resolve_fn_selector("set_default_ism", &[<ContractId>::param_type()]);
            let tokens = [module.into_token()];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `owner` function"]
        pub fn owner(&self) -> ContractCallHandler<Option<Identity>> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector = resolve_fn_selector("owner", &[]);
            let tokens = [];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
        #[doc = "Calls the contract's `transfer_ownership` function"]
        pub fn transfer_ownership(&self, new_owner: Option<Identity>) -> ContractCallHandler<()> {
            let provider = self.wallet.get_provider().expect("Provider not set up");
            let encoded_fn_selector =
                resolve_fn_selector("transfer_ownership", &[Option::<Identity>::param_type()]);
            let tokens = [new_owner.into_token()];
            let log_decoder = LogDecoder {
                logs_map: self.logs_map.clone(),
            };
            Contract::method_hash(
                &provider,
                self.contract_id.clone(),
                &self.wallet,
                encoded_fn_selector,
                &tokens,
                log_decoder,
            )
            .expect("method not found (this should never happen)")
        }
    }
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Message {
        pub version: u8,
        pub nonce: u32,
        pub origin: u32,
        pub sender: Bits256,
        pub destination: u32,
        pub recipient: Bits256,
        pub body: Vec<u8>,
    }
    impl Parameterize for Message {
        fn param_type() -> ParamType {
            let types = [
                ("version".to_string(), <u8>::param_type()),
                ("nonce".to_string(), <u32>::param_type()),
                ("origin".to_string(), <u32>::param_type()),
                ("sender".to_string(), <Bits256>::param_type()),
                ("destination".to_string(), <u32>::param_type()),
                ("recipient".to_string(), <Bits256>::param_type()),
                ("body".to_string(), Vec::<u8>::param_type()),
            ]
            .to_vec();
            ParamType::Struct {
                name: "Message".to_string(),
                fields: types,
                generics: [].to_vec(),
            }
        }
    }
    impl Tokenizable for Message {
        fn into_token(self) -> Token {
            let tokens = [
                self.version.into_token(),
                self.nonce.into_token(),
                self.origin.into_token(),
                self.sender.into_token(),
                self.destination.into_token(),
                self.recipient.into_token(),
                self.body.into_token(),
            ]
            .to_vec();
            Token::Struct(tokens)
        }
        fn from_token(token: Token) -> Result<Self, SDKError> {
            match token {
                Token::Struct(tokens) => {
                    let mut tokens_iter = tokens.into_iter();
                    let mut next_token = move || {
                        tokens_iter.next().ok_or_else(|| {
                            SDKError::InstantiationError(format!(
                                "Ran out of tokens before '{}' has finished construction!",
                                "Message"
                            ))
                        })
                    };
                    Ok(Self {
                        version: <u8>::from_token(next_token()?)?,
                        nonce: <u32>::from_token(next_token()?)?,
                        origin: <u32>::from_token(next_token()?)?,
                        sender: <Bits256>::from_token(next_token()?)?,
                        destination: <u32>::from_token(next_token()?)?,
                        recipient: <Bits256>::from_token(next_token()?)?,
                        body: <Vec<u8>>::from_token(next_token()?)?,
                    })
                }
                other => Err(SDKError::InstantiationError(format!(
                    "Error while constructing '{}'. Expected token of type Token::Struct, got {:?}",
                    "Message", other
                ))),
            }
        }
    }
    impl TryFrom<&[u8]> for Message {
        type Error = SDKError;
        fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
            try_from_bytes(bytes)
        }
    }
    impl TryFrom<&Vec<u8>> for Message {
        type Error = SDKError;
        fn try_from(bytes: &Vec<u8>) -> Result<Self, Self::Error> {
            try_from_bytes(&bytes)
        }
    }
    impl TryFrom<Vec<u8>> for Message {
        type Error = SDKError;
        fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
            try_from_bytes(&bytes)
        }
    }
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct OwnershipTransferredEvent {
        pub previous_owner: Option<Identity>,
        pub new_owner: Option<Identity>,
    }
    impl Parameterize for OwnershipTransferredEvent {
        fn param_type() -> ParamType {
            let types = [
                (
                    "previous_owner".to_string(),
                    Option::<Identity>::param_type(),
                ),
                ("new_owner".to_string(), Option::<Identity>::param_type()),
            ]
            .to_vec();
            ParamType::Struct {
                name: "OwnershipTransferredEvent".to_string(),
                fields: types,
                generics: [].to_vec(),
            }
        }
    }
    impl Tokenizable for OwnershipTransferredEvent {
        fn into_token(self) -> Token {
            let tokens = [
                self.previous_owner.into_token(),
                self.new_owner.into_token(),
            ]
            .to_vec();
            Token::Struct(tokens)
        }
        fn from_token(token: Token) -> Result<Self, SDKError> {
            match token {
                Token::Struct(tokens) => {
                    let mut tokens_iter = tokens.into_iter();
                    let mut next_token = move || {
                        tokens_iter.next().ok_or_else(|| {
                            SDKError::InstantiationError(format!(
                                "Ran out of tokens before '{}' has finished construction!",
                                "OwnershipTransferredEvent"
                            ))
                        })
                    };
                    Ok(Self {
                        previous_owner: <Option<Identity>>::from_token(next_token()?)?,
                        new_owner: <Option<Identity>>::from_token(next_token()?)?,
                    })
                }
                other => Err(SDKError::InstantiationError(format!(
                    "Error while constructing '{}'. Expected token of type Token::Struct, got {:?}",
                    "OwnershipTransferredEvent", other
                ))),
            }
        }
    }
    impl TryFrom<&[u8]> for OwnershipTransferredEvent {
        type Error = SDKError;
        fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
            try_from_bytes(bytes)
        }
    }
    impl TryFrom<&Vec<u8>> for OwnershipTransferredEvent {
        type Error = SDKError;
        fn try_from(bytes: &Vec<u8>) -> Result<Self, Self::Error> {
            try_from_bytes(&bytes)
        }
    }
    impl TryFrom<Vec<u8>> for OwnershipTransferredEvent {
        type Error = SDKError;
        fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
            try_from_bytes(&bytes)
        }
    }
}
