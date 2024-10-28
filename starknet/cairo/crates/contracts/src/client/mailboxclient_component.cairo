#[starknet::component]
pub mod MailboxclientComponent {
    use alexandria_bytes::Bytes;
    use contracts::interfaces::{IMailboxClient, IMailboxDispatcher, IMailboxDispatcherTrait};
    use openzeppelin::access::ownable::{
        OwnableComponent, OwnableComponent::InternalImpl, OwnableComponent::OwnableImpl
    };
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{ContractAddress, contract_address_const};

    #[storage]
    struct Storage {
        mailbox: IMailboxDispatcher,
        local_domain: u32,
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
    }

    pub mod Errors {
        pub const ADDRESS_CANNOT_BE_ZERO: felt252 = 'Address cannot be zero';
    }

    #[embeddable_as(MailboxClientImpl)]
    pub impl MailboxClient<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        impl Owner: OwnableComponent::HasComponent<TContractState>
    > of IMailboxClient<ComponentState<TContractState>> {
        /// Sets the address of the application's custom hook.
        /// Dev: callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * - `_hook` - The hook address to set 
        fn set_hook(ref self: ComponentState<TContractState>, _hook: ContractAddress) {
            let ownable_comp = get_dep_component!(@self, Owner);
            ownable_comp.assert_only_owner();
            assert(_hook != contract_address_const::<0>(), Errors::ADDRESS_CANNOT_BE_ZERO);
            self.hook.write(_hook);
        }

        /// Sets the address of the application's custom interchain security module.
        /// Dev: Callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * - '_module' - The address of the interchain security module contract.
        fn set_interchain_security_module(
            ref self: ComponentState<TContractState>, _module: ContractAddress
        ) {
            let ownable_comp = get_dep_component!(@self, Owner);
            ownable_comp.assert_only_owner();
            assert(_module != contract_address_const::<0>(), Errors::ADDRESS_CANNOT_BE_ZERO);
            self.interchain_security_module.write(_module);
        }

        /// Retrieves the local domain of the mailbox associated to the maiblox client. 
        /// 
        /// # Returns
        /// 
        /// u32  - The local domain
        fn get_local_domain(self: @ComponentState<TContractState>) -> u32 {
            self.mailbox.read().get_local_domain()
        }

        /// Retrieves the current hook set.
        /// 
        /// # Returns
        /// 
        /// ContractAddress  - The hook defined
        fn get_hook(self: @ComponentState<TContractState>) -> ContractAddress {
            self.hook.read()
        }

        /// Retrieves the current interchain security module 
        /// 
        /// # Returns
        /// 
        /// ContractAddress  - The defined ISM
        fn interchain_security_module(self: @ComponentState<TContractState>) -> ContractAddress {
            self.interchain_security_module.read()
        }

        /// Determines if a message associated to a given id is the mailbox's latest dispatched
        /// 
        /// # Arguments
        /// 
        /// * - `_id ` - The id to check
        /// 
        /// # Returns
        /// 
        /// boolean  - True if latest dispatched
        fn _is_latest_dispatched(self: @ComponentState<TContractState>, _id: u256) -> bool {
            self.mailbox.read().get_latest_dispatched_id() == _id
        }

        /// Determines if a message associated to a given id is delivered
        /// 
        /// # Arguments
        /// 
        /// * - `_id ` - The id to check
        /// 
        /// # Returns
        /// 
        /// boolean  - True if delivered
        fn _is_delivered(self: @ComponentState<TContractState>, _id: u256) -> bool {
            self.mailbox.read().delivered(_id)
        }

        /// Returns the mailbox contract address associated to the mailbox client
        /// 
        /// # Returns
        /// 
        /// ContractAddress  - the mailbox address associated to the client
        fn mailbox(self: @ComponentState<TContractState>) -> ContractAddress {
            let mailbox: IMailboxDispatcher = self.mailbox.read();
            mailbox.contract_address
        }

        /// Dispatches a message to the destination domain & recipient.
        /// 
        /// # Arguments
        /// 
        /// * - `_destination_domain` Domain of destination chain
        /// * - `_recipient` Address of recipient on destination chain
        /// * - `_message_body` Bytes content of message body
        /// * - `_fee_amount` - the payment provided for sending the message
        /// * - `_hook_metadata` Metadata used by the post dispatch hook
        /// * - `_hook` Custom hook to use instead of the default
        /// 
        /// # Returns 
        /// 
        /// u256 - The message ID inserted into the Mailbox's merkle tree
        fn _dispatch(
            self: @ComponentState<TContractState>,
            _destination_domain: u32,
            _recipient: u256,
            _message_body: Bytes,
            _fee_amount: u256,
            _hook_metadata: Option<Bytes>,
            _hook: Option<ContractAddress>
        ) -> u256 {
            self
                .mailbox
                .read()
                .dispatch(
                    _destination_domain,
                    _recipient,
                    _message_body,
                    _fee_amount,
                    _hook_metadata,
                    _hook
                )
        }

        /// Computes quote for dispatching a message to the destination domain & recipient.
        /// 
        /// # Arguments
        /// 
        /// * - `_destination_domain` Domain of destination chain
        /// * - `_recipient` Address of recipient on destination chain
        /// * - `_message_body` Bytes content of message body
        /// * - `_hook_metadata` Metadata used by the post dispatch hook
        /// * - `_hook` Custom hook to use instead of the default
        /// 
        /// # Returns 
        /// 
        /// u256 - The payment required to dispatch the message
        fn quote_dispatch(
            self: @ComponentState<TContractState>,
            _destination_domain: u32,
            _recipient: u256,
            _message_body: Bytes,
            _hook_metadata: Option<Bytes>,
            _hook: Option<ContractAddress>
        ) -> u256 {
            self
                .mailbox
                .read()
                .quote_dispatch(
                    _destination_domain, _recipient, _message_body, _hook_metadata, _hook
                )
        }
    }

    #[generate_trait]
    pub impl MailboxClientInternalImpl<
        TContractState, +HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        /// Initializes the mailbox client configuration.
        /// Dev: callable on constructor
        /// 
        /// # Arguments
        /// 
        /// * - `_mailbox` - mailbox contract address
        fn initialize(
            ref self: ComponentState<TContractState>,
            _mailbox: ContractAddress,
            _hook: Option<ContractAddress>,
            _interchain_security_module: Option<ContractAddress>,
        ) {
            let mailbox = IMailboxDispatcher { contract_address: _mailbox };
            self.mailbox.write(mailbox);
            self.local_domain.write(mailbox.get_local_domain());
            if let Option::Some(hook) = _hook {
                self.hook.write(hook);
            }
            if let Option::Some(ism) = _interchain_security_module {
                self.interchain_security_module.write(ism);
            }
        }
    }
}
