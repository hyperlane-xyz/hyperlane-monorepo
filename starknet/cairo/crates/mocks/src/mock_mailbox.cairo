use alexandria_bytes::Bytes;
use contracts::libs::message::Message;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockMailbox<TContractState> {
    fn add_remote_mail_box(ref self: TContractState, domain: u32, mailbox: ContractAddress);
    fn add_inbound_message(ref self: TContractState, message: Message);
    fn process_next_inbound_message(ref self: TContractState);
    fn get_local_domain(self: @TContractState) -> u32;
    fn delivered(self: @TContractState, _message_id: u256) -> bool;
    fn nonce(self: @TContractState) -> u32;
    fn get_default_ism(self: @TContractState) -> ContractAddress;
    fn get_default_hook(self: @TContractState) -> ContractAddress;
    fn get_required_hook(self: @TContractState) -> ContractAddress;
    fn get_latest_dispatched_id(self: @TContractState) -> u256;
    fn dispatch(
        ref self: TContractState,
        destination_domain: u32,
        recipient_address: u256,
        message_body: Bytes,
        fee_amount: u256,
        metadata: Option<Bytes>,
        hook: Option<ContractAddress>
    ) -> u256;
    fn quote_dispatch(
        self: @TContractState,
        _destination_domain: u32,
        _recipient_address: u256,
        _message_body: Bytes,
        _custom_hook_metadata: Option<Bytes>,
        _custom_hook: Option<ContractAddress>,
    ) -> u256;
    fn process(ref self: TContractState, _metadata: Bytes, _message: Message);
    fn recipient_ism(self: @TContractState, _recipient: u256) -> ContractAddress;
    fn set_default_ism(ref self: TContractState, _module: ContractAddress);
    fn set_default_hook(ref self: TContractState, _hook: ContractAddress);
    fn set_required_hook(ref self: TContractState, _hook: ContractAddress);
    fn processor(self: @TContractState, _id: u256) -> ContractAddress;
    fn processed_at(self: @TContractState, _id: u256) -> u64;
}

#[starknet::contract]
pub mod MockMailbox {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::interfaces::{
        IMailbox, IMailboxDispatcher, IMailboxDispatcherTrait, IInterchainSecurityModuleDispatcher,
        IInterchainSecurityModuleDispatcherTrait, ISpecifiesInterchainSecurityModuleDispatcher,
        ISpecifiesInterchainSecurityModuleDispatcherTrait, IMessageRecipientDispatcher,
        IMessageRecipientDispatcherTrait, ETH_ADDRESS,
    };
    use contracts::libs::message::{Message, MessageTrait, HYPERLANE_VERSION};
    use contracts::utils::utils::U256TryIntoContractAddress;
    use core::starknet::event::EventEmitter;
    use mocks::test_post_dispatch_hook::{
        ITestPostDispatchHookDispatcher, ITestPostDispatchHookDispatcherTrait
    };
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::interface::{
        ERC20ABI, ERC20ABIDispatcher, ERC20ABIDispatcherTrait
    };
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{
        ContractAddress, ClassHash, get_caller_address, get_block_number, contract_address_const,
        get_contract_address
    };
    use super::{IMockMailboxDispatcherTrait, IMockMailboxDispatcher};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[derive(Drop, Serde, starknet::Store)]
    pub struct Delivery {
        pub processor: ContractAddress,
        pub block_number: u64,
    }


    #[storage]
    struct Storage {
        inbound_unprocessed_nonce: u32,
        inbound_processed_nonce: u32,
        remote_mailboxes: LegacyMap<u32, ContractAddress>,
        inbound_messages: LegacyMap<u32, Message>,
        eth_address: ContractAddress,
        // Domain of chain on which the contract is deployed
        local_domain: u32,
        // A monotonically increasing nonce for outbound unique message IDs.
        nonce: u32,
        // The latest dispatched message ID used for auth in post-dispatch hooks.
        latest_dispatched_id: u256,
        // The default ISM, used if the recipient fails to specify one.
        default_ism: ContractAddress,
        // The default post dispatch hook, used for post processing of opting-in dispatches.
        default_hook: ContractAddress,
        // The required post dispatch hook, used for post processing of ALL dispatches.
        required_hook: ContractAddress,
        // Mapping of message ID to delivery context that processed the message.        
        deliveries: LegacyMap::<u256, Delivery>,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        DefaultIsmSet: DefaultIsmSet,
        DefaultHookSet: DefaultHookSet,
        RequiredHookSet: RequiredHookSet,
        Process: Process,
        ProcessId: ProcessId,
        Dispatch: Dispatch,
        DispatchId: DispatchId,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
    }

    #[derive(starknet::Event, Drop)]
    pub struct DefaultIsmSet {
        pub module: ContractAddress
    }

    #[derive(starknet::Event, Drop)]
    pub struct DefaultHookSet {
        pub hook: ContractAddress
    }

    #[derive(starknet::Event, Drop)]
    pub struct RequiredHookSet {
        pub hook: ContractAddress
    }

    #[derive(starknet::Event, Drop)]
    pub struct Process {
        pub origin: u32,
        pub sender: u256,
        pub recipient: u256
    }

    #[derive(starknet::Event, Drop)]
    pub struct ProcessId {
        pub id: u256
    }

    #[derive(starknet::Event, Drop)]
    pub struct Dispatch {
        pub sender: u256,
        pub destination_domain: u32,
        pub recipient_address: u256,
        pub message: Message
    }

    #[derive(starknet::Event, Drop)]
    pub struct DispatchId {
        pub id: u256
    }


    pub mod Errors {
        pub const WRONG_HYPERLANE_VERSION: felt252 = 'Wrong hyperlane version';
        pub const UNEXPECTED_DESTINATION: felt252 = 'Unexpected destination';
        pub const ALREADY_DELIVERED: felt252 = 'Mailbox: already delivered';
        pub const ISM_VERIFICATION_FAILED: felt252 = 'Mailbox:ism verification failed';
        pub const ISM_CANNOT_BE_NULL: felt252 = 'ISM cannot be null';
        pub const OWNER_CANNOT_BE_NULL: felt252 = 'ISM cannot be null';
        pub const HOOK_CANNOT_BE_NULL: felt252 = 'Hook cannot be null';
        pub const NO_ISM_FOUND: felt252 = 'ISM: no ISM found';
        pub const NEW_OWNER_IS_ZERO: felt252 = 'Ownable: new owner cannot be 0';
        pub const ALREADY_OWNER: felt252 = 'Ownable: already owner';
        pub const INSUFFICIENT_BALANCE: felt252 = 'Insufficient balance';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'Insufficient allowance';
        pub const NOT_ENOUGH_FEE_PROVIDED: felt252 = 'Provided fee < needed fee';
        pub const SIZE_DOES_NOT_MATCH_MESSAGE_BODY: felt252 = 'Size does not match msg body';
        pub const SIZE_DOES_NOT_MATCH_METADATA: felt252 = 'Size does not match metadata';
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        _local_domain: u32,
        _default_ism: ContractAddress,
        hook: ContractAddress,
        eth_address: ContractAddress
    ) {
        self.local_domain.write(_local_domain);
        self.default_ism.write(_default_ism);
        self.default_hook.write(hook);
        self.required_hook.write(hook);
        self.eth_address.write(eth_address);
        self.ownable.initializer(get_caller_address());
    }

    #[abi(embed_v0)]
    impl Upgradeable of IUpgradeable<ContractState> {
        /// Upgrades the contract to a new implementation.
        /// Callable only by the owner
        /// # Arguments
        ///
        /// * `new_class_hash` - The class hash of the new implementation.
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    #[abi(embed_v0)]
    impl IMailboxImpl of super::IMockMailbox<ContractState> {
        fn add_remote_mail_box(ref self: ContractState, domain: u32, mailbox: ContractAddress) {
            self.remote_mailboxes.write(domain, mailbox);
        }
        fn dispatch(
            ref self: ContractState,
            destination_domain: u32,
            recipient_address: u256,
            message_body: Bytes,
            fee_amount: u256,
            metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256 {
            let hook = match hook {
                Option::Some(hook) => { hook },
                Option::None(()) => { self.default_hook.read() }
            };
            let (id, message) = build_message(
                @self, destination_domain, recipient_address, message_body.clone()
            );
            self.latest_dispatched_id.write(id);
            let curr_nonce = self.nonce.read();
            self.nonce.write(curr_nonce + 1);
            let caller_address: felt252 = starknet::get_caller_address().into();
            self
                .emit(
                    Dispatch {
                        sender: caller_address.into(),
                        destination_domain,
                        recipient_address,
                        message: message.clone()
                    }
                );
            self.emit(DispatchId { id });

            let metadata = match metadata {
                Option::Some(metadata) => metadata,
                Option::None(()) => BytesTrait::new_empty()
            };
            let required_hook = ITestPostDispatchHookDispatcher {
                contract_address: self.required_hook.read()
            };
            required_hook.post_dispatch(metadata.clone(), message.clone());
            let hook = ITestPostDispatchHookDispatcher { contract_address: hook };
            hook.post_dispatch(metadata, message.clone());
            let remote_mailbox = self.remote_mailboxes.read(destination_domain);
            assert!(remote_mailbox != contract_address_const::<0>());
            IMockMailboxDispatcher { contract_address: remote_mailbox }
                .add_inbound_message(message);
            id
        }

        fn add_inbound_message(ref self: ContractState, message: Message) {
            self.inbound_messages.write(self.inbound_unprocessed_nonce.read(), message);
            self.inbound_unprocessed_nonce.write(self.inbound_unprocessed_nonce.read() + 1);
        }

        fn process_next_inbound_message(ref self: ContractState) {
            let message = self.inbound_messages.read(self.inbound_processed_nonce.read());
            IMailboxDispatcher { contract_address: starknet::get_contract_address() }
                .process(BytesTrait::new_empty(), message);
            self.inbound_processed_nonce.write(self.inbound_processed_nonce.read() + 1);
        }
        fn get_local_domain(self: @ContractState) -> u32 {
            self.local_domain.read()
        }

        fn get_default_ism(self: @ContractState) -> ContractAddress {
            self.default_ism.read()
        }

        fn get_default_hook(self: @ContractState) -> ContractAddress {
            self.default_hook.read()
        }

        fn get_required_hook(self: @ContractState) -> ContractAddress {
            self.required_hook.read()
        }

        fn get_latest_dispatched_id(self: @ContractState) -> u256 {
            self.latest_dispatched_id.read()
        }

        /// Sets the default ISM for the Mailbox.
        /// Callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * `_hook` - The new default ISM
        fn set_default_ism(ref self: ContractState, _module: ContractAddress) {
            self.ownable.assert_only_owner();
            self.default_ism.write(_module);
            self.emit(DefaultIsmSet { module: _module });
        }

        /// Sets the default post dispatch hook for the Mailbox.
        /// Callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * `_hook` - The new default post dispatch hook. 
        fn set_default_hook(ref self: ContractState, _hook: ContractAddress) {
            self.ownable.assert_only_owner();
            self.default_hook.write(_hook);
            self.emit(DefaultHookSet { hook: _hook });
        }

        /// Sets the required post dispatch hook for the Mailbox.
        /// Callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * `_hook` - The new required post dispatch hook. 
        fn set_required_hook(ref self: ContractState, _hook: ContractAddress) {
            self.ownable.assert_only_owner();
            self.required_hook.write(_hook);
            self.emit(RequiredHookSet { hook: _hook });
        }


        /// Returns true if the message has been processed.
        /// 
        /// # Arguments
        /// 
        /// * `_message_id` - The message ID to check.
        /// 
        ///  # Returns
        /// 
        /// * True if the message has been delivered.
        fn delivered(self: @ContractState, _message_id: u256) -> bool {
            self.deliveries.read(_message_id).block_number > 0
        }

        fn nonce(self: @ContractState) -> u32 {
            self.nonce.read()
        }

        /// Attempts to deliver `_message` to its recipient. Verifies `_message` via the recipient's ISM using the provided `_metadata`
        /// 
        /// # Arguments
        /// 
        /// * `_metadata` - Metadata used by the ISM to verify `_message`.
        /// * `_message` -  Formatted Hyperlane message (ref: message.cairo) 
        fn process(ref self: ContractState, _metadata: Bytes, _message: Message) {
            let mut sanitized_bytes_metadata = BytesTrait::new_empty();
            sanitized_bytes_metadata.concat(@_metadata);
            assert(sanitized_bytes_metadata == _metadata, Errors::SIZE_DOES_NOT_MATCH_METADATA);
            let mut sanitized_bytes_message_body = BytesTrait::new_empty();
            sanitized_bytes_message_body.concat(@_message.body);
            assert(
                sanitized_bytes_message_body == _message.body,
                Errors::SIZE_DOES_NOT_MATCH_MESSAGE_BODY
            );

            assert(_message.version == HYPERLANE_VERSION, Errors::WRONG_HYPERLANE_VERSION);
            assert(
                _message.destination == self.local_domain.read(), Errors::UNEXPECTED_DESTINATION
            );
            let (id, _) = MessageTrait::format_message(_message.clone());
            let caller = get_caller_address();
            let block_number = get_block_number();
            assert(!self.delivered(id), Errors::ALREADY_DELIVERED);

            self.deliveries.write(id, Delivery { processor: caller, block_number: block_number });

            let recipient_ism = self.recipient_ism(_message.recipient);
            let ism = IInterchainSecurityModuleDispatcher { contract_address: recipient_ism };

            self
                .emit(
                    Process {
                        origin: _message.origin,
                        sender: _message.sender,
                        recipient: _message.recipient
                    }
                );
            self.emit(ProcessId { id: id });

            assert(ism.verify(_metadata, _message.clone()), Errors::ISM_VERIFICATION_FAILED);

            let message_recipient = IMessageRecipientDispatcher {
                contract_address: _message.recipient.try_into().unwrap()
            };
            message_recipient.handle(_message.origin, _message.sender, _message.body);
        }

        /// Computes quote for dispatching a message to the destination domain & recipient.
        /// 
        /// # Arguments
        /// 
        /// * `_destination_domain` - Domain of destination chain
        /// * `_recipient_address` -  Address of recipient on destination chain 
        /// * `_message_body` - Raw bytes content of message body
        /// * `_custom_hook_metadata` - Metadata used by the post dispatch hook
        /// * `_custom_hook` - Custom hook to use instead of the default
        /// 
        ///  # Returns
        /// 
        /// * The payment required to dispatch the message
        fn quote_dispatch(
            self: @ContractState,
            _destination_domain: u32,
            _recipient_address: u256,
            _message_body: Bytes,
            _custom_hook_metadata: Option<Bytes>,
            _custom_hook: Option<ContractAddress>,
        ) -> u256 {
            let hook_address = match _custom_hook {
                Option::Some(hook) => hook,
                Option::None(()) => self.default_hook.read()
            };
            let hook_metadata = match _custom_hook_metadata {
                Option::Some(hook_metadata) => hook_metadata,
                Option::None(()) => BytesTrait::new_empty(),
            };
            let (_, message) = build_message(
                self, _destination_domain, _recipient_address, _message_body.clone()
            );
            let required_hook_address = self.required_hook.read();
            let required_hook = ITestPostDispatchHookDispatcher {
                contract_address: required_hook_address
            };
            let hook = ITestPostDispatchHookDispatcher { contract_address: hook_address };
            required_hook.quote_dispatch(hook_metadata.clone(), message.clone())
                + hook.quote_dispatch(hook_metadata, message)
        }

        /// Returns the ISM to use for the recipient, defaulting to the default ISM if none is specified.
        /// 
        /// # Arguments
        /// 
        /// * `_recipient` - The message recipient whose ISM should be returned.
        /// 
        ///  # Returns
        /// 
        /// * The ISM to use for `_recipient`
        fn recipient_ism(self: @ContractState, _recipient: u256) -> ContractAddress {
            let mut call_data: Array<felt252> = ArrayTrait::new();
            let mut res = starknet::syscalls::call_contract_syscall(
                _recipient.try_into().unwrap(),
                selector!("interchain_security_module"),
                call_data.span()
            );
            let mut ism_res = match res {
                Result::Ok(ism) => ism,
                Result::Err(revert_reason) => {
                    assert(revert_reason == array!['ENTRYPOINT_FAILED'], Errors::NO_ISM_FOUND);
                    array![].span()
                }
            };
            if (ism_res.len() != 0) {
                let ism_address = Serde::<ContractAddress>::deserialize(ref ism_res).unwrap();
                if (ism_address != contract_address_const::<0>()) {
                    return ism_address;
                }
            }
            self.default_ism.read()
        }

        /// Returns the account that processed the message.
        /// 
        /// # Arguments
        /// 
        /// * `_id` - The message ID to check.
        /// 
        ///  # Returns
        /// 
        /// * The account that processed the message.
        fn processor(self: @ContractState, _id: u256) -> ContractAddress {
            self.deliveries.read(_id).processor
        }

        ///  Returns the account that processed the message.
        /// 
        /// # Arguments
        /// 
        /// * `_id` - The message ID to check.
        /// 
        ///  # Returns
        /// 
        /// * The number of the block that the message was processed at.
        fn processed_at(self: @ContractState, _id: u256) -> u64 {
            self.deliveries.read(_id).block_number
        }
    }

    fn build_message(
        self: @ContractState,
        _destination_domain: u32,
        _recipient_address: u256,
        _message_body: Bytes
    ) -> (u256, Message) {
        let nonce = self.nonce.read();
        let local_domain = self.local_domain.read();
        let caller: felt252 = get_caller_address().into();
        MessageTrait::format_message(
            Message {
                version: HYPERLANE_VERSION,
                nonce: nonce,
                origin: local_domain,
                sender: caller.into(),
                destination: _destination_domain,
                recipient: _recipient_address,
                body: _message_body
            }
        )
    }
    #[generate_trait]
    impl Private of PrivateTrait {
        fn _dispatch(
            ref self: ContractState,
            _destination_domain: u32,
            _recipient_address: u256,
            _message_body: Bytes,
            _fee_amount: u256,
            _custom_hook_metadata: Option<Bytes>,
            _custom_hook: Option<ContractAddress>
        ) -> u256 {
            let hook = match _custom_hook {
                Option::Some(hook) => hook,
                Option::None(()) => self.default_hook.read(),
            };
            let hook_metadata = match _custom_hook_metadata {
                Option::Some(hook_metadata) => { hook_metadata },
                Option::None(()) => BytesTrait::new_empty()
            };
            let (id, message) = build_message(
                @self, _destination_domain, _recipient_address, _message_body
            );
            self.latest_dispatched_id.write(id);
            let current_nonce = self.nonce.read();
            self.nonce.write(current_nonce + 1);
            let caller: felt252 = get_caller_address().into();
            self
                .emit(
                    Dispatch {
                        sender: caller.into(),
                        destination_domain: _destination_domain,
                        recipient_address: _recipient_address,
                        message: message.clone()
                    }
                );
            self.emit(DispatchId { id: id });

            // HOOKS

            let required_hook_address = self.required_hook.read();
            let required_hook = ITestPostDispatchHookDispatcher {
                contract_address: required_hook_address
            };
            let mut required_fee = required_hook
                .quote_dispatch(hook_metadata.clone(), message.clone());
            let hook_dispatcher = ITestPostDispatchHookDispatcher { contract_address: hook };
            let default_fee = hook_dispatcher
                .quote_dispatch(hook_metadata.clone(), message.clone());

            assert(_fee_amount >= required_fee + default_fee, Errors::NOT_ENOUGH_FEE_PROVIDED);

            let caller_address = get_caller_address();
            let contract_address = get_contract_address();

            let token_dispatcher = ERC20ABIDispatcher { contract_address: self.eth_address.read() };
            let user_balance = token_dispatcher.balanceOf(caller_address);
            assert(user_balance >= required_fee + default_fee, Errors::INSUFFICIENT_BALANCE);

            assert(
                token_dispatcher.allowance(caller_address, contract_address) >= _fee_amount,
                Errors::INSUFFICIENT_ALLOWANCE
            );

            if (required_fee > 0) {
                token_dispatcher.transferFrom(caller_address, required_hook_address, required_fee);
            }
            required_hook.post_dispatch(hook_metadata.clone(), message.clone());
            if (default_fee > 0) {
                token_dispatcher.transferFrom(caller_address, hook, default_fee);
            }
            hook_dispatcher.post_dispatch(hook_metadata, message.clone());
            id
        }
    }
}
