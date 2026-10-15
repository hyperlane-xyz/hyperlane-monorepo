#[allow(clippy::too_many_arguments)]
#[no_implicit_prelude]
pub mod abigen_bindings {
    use ::core::{
        clone::Clone,
        convert::{From, Into, TryFrom},
        iter::IntoIterator,
        iter::Iterator,
        marker::Sized,
        panic,
    };
    use ::std::{default::Default, format, string::ToString, vec};
    #[allow(clippy::too_many_arguments)]
    #[no_implicit_prelude]
    pub mod mailbox_mod {
        use ::core::{
            clone::Clone,
            convert::{From, Into, TryFrom},
            iter::IntoIterator,
            iter::Iterator,
            marker::Sized,
            panic,
        };
        use ::std::{default::Default, format, string::ToString, vec};
        const _ : & [u8] = include_bytes ! ("/data/sandbox/template/hyperlane-monorepo/_building/rust/main/chains/hyperlane-fuel/./abis/Mailbox.abi.json") ;
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum AccessError {
            NotOwner,
        }
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum InitializationError {
            CannotReinitialized,
        }
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum MailboxError {
            InvalidISMAddress,
            InvalidHookAddress,
            InvalidProtocolVersion(::core::primitive::u8),
            InvalidMessageOrigin(::core::primitive::u32),
            MessageAlreadyDelivered,
            MessageVerificationFailed,
            AlreadyInitialized,
            MessageTooLarge(::core::primitive::u64),
        }
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum PauseError {
            Paused,
            NotPaused,
        }
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum ReentrancyError {
            NonReentrant,
        }
        #[allow(clippy::enum_variant_names)]
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub enum State {
            Uninitialized,
            Initialized(::fuels::types::Identity),
            Revoked,
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct DefaultHookSetEvent {
            pub module: ::fuels::types::ContractId,
        }
        impl DefaultHookSetEvent {
            pub fn new(module: ::fuels::types::ContractId) -> Self {
                Self { module }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct DefaultIsmSetEvent {
            pub module: ::fuels::types::ContractId,
        }
        impl DefaultIsmSetEvent {
            pub fn new(module: ::fuels::types::ContractId) -> Self {
                Self { module }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct DispatchEvent {
            pub message_id: ::fuels::types::Bits256,
            pub destination_domain: ::core::primitive::u32,
            pub recipient_address: ::fuels::types::Bits256,
            pub message: self::EncodedMessage,
        }
        impl DispatchEvent {
            pub fn new(
                message_id: ::fuels::types::Bits256,
                destination_domain: ::core::primitive::u32,
                recipient_address: ::fuels::types::Bits256,
                message: self::EncodedMessage,
            ) -> Self {
                Self {
                    message_id,
                    destination_domain,
                    recipient_address,
                    message,
                }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct DispatchIdEvent {
            pub message_id: ::fuels::types::Bits256,
        }
        impl DispatchIdEvent {
            pub fn new(message_id: ::fuels::types::Bits256) -> Self {
                Self { message_id }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct EncodedMessage {
            pub bytes: ::fuels::types::Bytes,
        }
        impl EncodedMessage {
            pub fn new(bytes: ::fuels::types::Bytes) -> Self {
                Self { bytes }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct OwnershipRenounced {
            pub previous_owner: ::fuels::types::Identity,
        }
        impl OwnershipRenounced {
            pub fn new(previous_owner: ::fuels::types::Identity) -> Self {
                Self { previous_owner }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct OwnershipSet {
            pub new_owner: ::fuels::types::Identity,
        }
        impl OwnershipSet {
            pub fn new(new_owner: ::fuels::types::Identity) -> Self {
                Self { new_owner }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct OwnershipTransferred {
            pub new_owner: ::fuels::types::Identity,
            pub previous_owner: ::fuels::types::Identity,
        }
        impl OwnershipTransferred {
            pub fn new(
                new_owner: ::fuels::types::Identity,
                previous_owner: ::fuels::types::Identity,
            ) -> Self {
                Self {
                    new_owner,
                    previous_owner,
                }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct ProcessEvent {
            pub message_id: ::fuels::types::Bits256,
            pub origin: ::core::primitive::u32,
            pub sender: ::fuels::types::Bits256,
            pub recipient: ::fuels::types::Bits256,
        }
        impl ProcessEvent {
            pub fn new(
                message_id: ::fuels::types::Bits256,
                origin: ::core::primitive::u32,
                sender: ::fuels::types::Bits256,
                recipient: ::fuels::types::Bits256,
            ) -> Self {
                Self {
                    message_id,
                    origin,
                    sender,
                    recipient,
                }
            }
        }
        #[derive(
            Clone,
            Debug,
            Eq,
            PartialEq,
            :: fuels :: macros :: Parameterize,
            :: fuels :: macros :: Tokenizable,
            :: fuels :: macros :: TryFrom,
        )]
        pub struct RequiredHookSetEvent {
            pub module: ::fuels::types::ContractId,
        }
        impl RequiredHookSetEvent {
            pub fn new(module: ::fuels::types::ContractId) -> Self {
                Self { module }
            }
        }
        #[derive(Debug, Clone)]
        pub struct Mailbox<A: ::fuels::accounts::Account> {
            contract_id: ::fuels::types::bech32::Bech32ContractId,
            account: A,
            log_decoder: ::fuels::core::codec::LogDecoder,
            encoder_config: ::fuels::core::codec::EncoderConfig,
        }
        impl<A: ::fuels::accounts::Account> Mailbox<A> {
            pub fn new(
                contract_id: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
                account: A,
            ) -> Self {
                let contract_id: ::fuels::types::bech32::Bech32ContractId = contract_id.into();
                let log_decoder = ::fuels::core::codec::LogDecoder::new(
                    ::fuels::core::codec::log_formatters_lookup(
                        vec![
                            (
                                "5557842539076482339".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::ReentrancyError>(),
                            ),
                            (
                                "10032608944051208538".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::PauseError>(),
                            ),
                            (
                                "4904025822840310122".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::MailboxError>(),
                            ),
                            (
                                "10811788483172643035".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::DispatchEvent>(),
                            ),
                            (
                                "2522729423758891677".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::DispatchIdEvent>(),
                            ),
                            (
                                "2161305517876418151".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::InitializationError>(
                                ),
                            ),
                            (
                                "16280289466020123285".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::OwnershipSet>(),
                            ),
                            (
                                "7929134096091764817".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::ProcessEvent>(),
                            ),
                            (
                                "4571204900286667806".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::AccessError>(),
                            ),
                            (
                                "14400248731700551312".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::DefaultHookSetEvent>(
                                ),
                            ),
                            (
                                "1889958695533330661".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::DefaultIsmSetEvent>(
                                ),
                            ),
                            (
                                "1134555198745859881".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::RequiredHookSetEvent>(
                                ),
                            ),
                            (
                                "4883303303013154842".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::OwnershipRenounced>(
                                ),
                            ),
                            (
                                "12970362301975156672".to_string(),
                                ::fuels::core::codec::LogFormatter::new::<self::OwnershipTransferred>(
                                ),
                            ),
                        ],
                        contract_id.clone().into(),
                    ),
                );
                let encoder_config = ::fuels::core::codec::EncoderConfig::default();
                Self {
                    contract_id,
                    account,
                    log_decoder,
                    encoder_config,
                }
            }
            pub fn contract_id(&self) -> &::fuels::types::bech32::Bech32ContractId {
                &self.contract_id
            }
            pub fn account(&self) -> A {
                self.account.clone()
            }
            pub fn with_account<U: ::fuels::accounts::Account>(self, account: U) -> Mailbox<U> {
                Mailbox {
                    contract_id: self.contract_id,
                    account,
                    log_decoder: self.log_decoder,
                    encoder_config: self.encoder_config,
                }
            }
            pub fn with_encoder_config(
                mut self,
                encoder_config: ::fuels::core::codec::EncoderConfig,
            ) -> Mailbox<A> {
                self.encoder_config = encoder_config;
                self
            }
            pub async fn get_balances(
                &self,
            ) -> ::fuels::types::errors::Result<
                ::std::collections::HashMap<::fuels::types::AssetId, u64>,
            > {
                ::fuels::accounts::ViewOnlyAccount::try_provider(&self.account)?
                    .get_contract_balances(&self.contract_id)
                    .await
                    .map_err(::std::convert::Into::into)
            }
            pub fn methods(&self) -> MailboxMethods<A> {
                MailboxMethods {
                    contract_id: self.contract_id.clone(),
                    account: self.account.clone(),
                    log_decoder: self.log_decoder.clone(),
                    encoder_config: self.encoder_config.clone(),
                }
            }
        }
        pub struct MailboxMethods<A: ::fuels::accounts::Account> {
            contract_id: ::fuels::types::bech32::Bech32ContractId,
            account: A,
            log_decoder: ::fuels::core::codec::LogDecoder,
            encoder_config: ::fuels::core::codec::EncoderConfig,
        }
        impl<A: ::fuels::accounts::Account> MailboxMethods<A> {
            #[doc = " Gets the default hook used for message processing."]
            pub fn default_hook(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::ContractId,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("default_hook"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Gets the default ISM used for message verification."]
            pub fn default_ism(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::ContractId,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("default_ism"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Returns true if the message has been processed."]
            #[doc = ""]
            #[doc = " ### Arguments"]
            #[doc = ""]
            #[doc = " * `message_id` - The unique identifier of the message."]
            pub fn delivered(
                &self,
                message_id: ::fuels::types::Bits256,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::core::primitive::bool,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("delivered"),
                    &[::fuels::core::traits::Tokenizable::into_token(message_id)],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Dispatches a message to the destination domain and recipient."]
            #[doc = " Returns the message's ID."]
            #[doc = ""]
            #[doc = " ### Arguments"]
            #[doc = ""]
            #[doc = " * `destination_domain` - The domain of the destination chain."]
            #[doc = " * `recipient` - Address of the recipient on the destination chain."]
            #[doc = " * `message_body` - Raw bytes content of the message body."]
            pub fn dispatch(
                &self,
                destination_domain: ::core::primitive::u32,
                recipient_address: ::fuels::types::Bits256,
                message_body: ::fuels::types::Bytes,
                metadata: ::fuels::types::Bytes,
                hook: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::Bits256,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("dispatch"),
                    &[
                        ::fuels::core::traits::Tokenizable::into_token(destination_domain),
                        ::fuels::core::traits::Tokenizable::into_token(recipient_address),
                        ::fuels::core::traits::Tokenizable::into_token(message_body),
                        ::fuels::core::traits::Tokenizable::into_token(metadata),
                        ::fuels::core::traits::Tokenizable::into_token(
                            <::fuels::types::ContractId>::from(hook.into()),
                        ),
                    ],
                    self.log_decoder.clone(),
                    true,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Initializes the contract."]
            pub fn initialize(
                &self,
                owner: ::fuels::types::Bits256,
                default_ism: ::fuels::types::Bits256,
                default_hook: ::fuels::types::Bits256,
                required_hook: ::fuels::types::Bits256,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("initialize"),
                    &[
                        ::fuels::core::traits::Tokenizable::into_token(owner),
                        ::fuels::core::traits::Tokenizable::into_token(default_ism),
                        ::fuels::core::traits::Tokenizable::into_token(default_hook),
                        ::fuels::core::traits::Tokenizable::into_token(required_hook),
                    ],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn latest_dispatched_id(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::Bits256,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("latest_dispatched_id"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Returns the domain of the chain where the contract is deployed."]
            pub fn local_domain(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::core::primitive::u32,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("local_domain"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn nonce(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::core::primitive::u32,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("nonce"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Processes a message."]
            #[doc = ""]
            #[doc = " ### Arguments"]
            #[doc = ""]
            #[doc = " * `metadata` - The metadata for ISM verification."]
            #[doc = " * `message` - The message as emitted by dispatch."]
            pub fn process(
                &self,
                metadata: ::fuels::types::Bytes,
                message: ::fuels::types::Bytes,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("process"),
                    &[
                        ::fuels::core::traits::Tokenizable::into_token(metadata),
                        ::fuels::core::traits::Tokenizable::into_token(message),
                    ],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Quotes the cost of dispatching a message to the destination domain and recipient."]
            #[doc = ""]
            #[doc = " ### Arguments"]
            #[doc = ""]
            #[doc = " * `destination_domain` - The domain of the destination chain."]
            #[doc = " * `recipient` - Address of the recipient on the destination chain."]
            #[doc = " * `message_body` - Raw bytes content of the message body."]
            pub fn quote_dispatch(
                &self,
                destination_domain: ::core::primitive::u32,
                recipient_address: ::fuels::types::Bits256,
                message_body: ::fuels::types::Bytes,
                metadata: ::fuels::types::Bytes,
                hook: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::core::primitive::u64,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("quote_dispatch"),
                    &[
                        ::fuels::core::traits::Tokenizable::into_token(destination_domain),
                        ::fuels::core::traits::Tokenizable::into_token(recipient_address),
                        ::fuels::core::traits::Tokenizable::into_token(message_body),
                        ::fuels::core::traits::Tokenizable::into_token(metadata),
                        ::fuels::core::traits::Tokenizable::into_token(
                            <::fuels::types::ContractId>::from(hook.into()),
                        ),
                    ],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn recipient_ism(
                &self,
                recipient: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::ContractId,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("recipient_ism"),
                    &[::fuels::core::traits::Tokenizable::into_token(
                        <::fuels::types::ContractId>::from(recipient.into()),
                    )],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Gets the required hook used for message processing."]
            pub fn required_hook(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::fuels::types::ContractId,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("required_hook"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Sets the default hook used for message processing."]
            pub fn set_default_hook(
                &self,
                module: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("set_default_hook"),
                    &[::fuels::core::traits::Tokenizable::into_token(
                        <::fuels::types::ContractId>::from(module.into()),
                    )],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Sets the default ISM used for message verification."]
            #[doc = ""]
            #[doc = " ### Arguments"]
            #[doc = ""]
            #[doc = " * `module` - Address implementing ISM interface."]
            pub fn set_default_ism(
                &self,
                module: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("set_default_ism"),
                    &[::fuels::core::traits::Tokenizable::into_token(
                        <::fuels::types::ContractId>::from(module.into()),
                    )],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            #[doc = " Sets the required hook used for message processing."]
            pub fn set_required_hook(
                &self,
                module: impl ::core::convert::Into<::fuels::types::bech32::Bech32ContractId>,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("set_required_hook"),
                    &[::fuels::core::traits::Tokenizable::into_token(
                        <::fuels::types::ContractId>::from(module.into()),
                    )],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn is_paused(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                ::core::primitive::bool,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("is_paused"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn pause(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("pause"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn unpause(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("unpause"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn initialize_ownership(
                &self,
                new_owner: ::fuels::types::Identity,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("initialize_ownership"),
                    &[::fuels::core::traits::Tokenizable::into_token(new_owner)],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn only_owner(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("only_owner"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn owner(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<
                A,
                ::fuels::programs::calls::ContractCall,
                self::State,
            > {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("owner"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn renounce_ownership(
                &self,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("renounce_ownership"),
                    &[],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
            pub fn transfer_ownership(
                &self,
                new_owner: ::fuels::types::Identity,
            ) -> ::fuels::programs::calls::CallHandler<A, ::fuels::programs::calls::ContractCall, ()>
            {
                ::fuels::programs::calls::CallHandler::new_contract_call(
                    self.contract_id.clone(),
                    self.account.clone(),
                    ::fuels::core::codec::encode_fn_selector("transfer_ownership"),
                    &[::fuels::core::traits::Tokenizable::into_token(new_owner)],
                    self.log_decoder.clone(),
                    false,
                    self.encoder_config.clone(),
                )
            }
        }
        impl<A: ::fuels::accounts::Account> ::fuels::programs::calls::ContractDependency for Mailbox<A> {
            fn id(&self) -> ::fuels::types::bech32::Bech32ContractId {
                self.contract_id.clone()
            }
            fn log_decoder(&self) -> ::fuels::core::codec::LogDecoder {
                self.log_decoder.clone()
            }
        }
        #[derive(Clone, Debug, Default)]
        pub struct MailboxConfigurables {
            offsets_with_data: ::std::vec::Vec<(u64, ::std::vec::Vec<u8>)>,
            encoder: ::fuels::core::codec::ABIEncoder,
        }
        impl MailboxConfigurables {
            pub fn new(encoder_config: ::fuels::core::codec::EncoderConfig) -> Self {
                Self {
                    encoder: ::fuels::core::codec::ABIEncoder::new(encoder_config),
                    ..::std::default::Default::default()
                }
            }
            #[allow(non_snake_case)]
            pub fn with_LOCAL_DOMAIN(
                mut self,
                value: ::core::primitive::u32,
            ) -> ::fuels::prelude::Result<Self> {
                let encoded = self.encoder.encode(&[
                    <::core::primitive::u32 as ::fuels::core::traits::Tokenizable>::into_token(
                        value,
                    ),
                ])?;
                self.offsets_with_data.push((51792u64, encoded));
                ::fuels::prelude::Result::Ok(self)
            }
        }
        impl From<MailboxConfigurables> for ::fuels::core::Configurables {
            fn from(config: MailboxConfigurables) -> Self {
                ::fuels::core::Configurables::new(config.offsets_with_data)
            }
        }
    }
}
pub use abigen_bindings::mailbox_mod::AccessError;
pub use abigen_bindings::mailbox_mod::DefaultHookSetEvent;
pub use abigen_bindings::mailbox_mod::DefaultIsmSetEvent;
pub use abigen_bindings::mailbox_mod::DispatchEvent;
pub use abigen_bindings::mailbox_mod::DispatchIdEvent;
pub use abigen_bindings::mailbox_mod::EncodedMessage;
pub use abigen_bindings::mailbox_mod::InitializationError;
pub use abigen_bindings::mailbox_mod::Mailbox;
pub use abigen_bindings::mailbox_mod::MailboxConfigurables;
pub use abigen_bindings::mailbox_mod::MailboxError;
pub use abigen_bindings::mailbox_mod::MailboxMethods;
pub use abigen_bindings::mailbox_mod::OwnershipRenounced;
pub use abigen_bindings::mailbox_mod::OwnershipSet;
pub use abigen_bindings::mailbox_mod::OwnershipTransferred;
pub use abigen_bindings::mailbox_mod::PauseError;
pub use abigen_bindings::mailbox_mod::ProcessEvent;
pub use abigen_bindings::mailbox_mod::ReentrancyError;
pub use abigen_bindings::mailbox_mod::RequiredHookSetEvent;
pub use abigen_bindings::mailbox_mod::State;
