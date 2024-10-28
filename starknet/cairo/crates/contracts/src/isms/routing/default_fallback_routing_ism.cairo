#[starknet::contract]
pub mod default_fallback_routing_ism {
    use alexandria_bytes::Bytes;
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientInternalImpl,
        MailboxclientComponent::MailboxClientImpl
    };
    use contracts::interfaces::{
        IDomainRoutingIsm, IRoutingIsm, IInterchainSecurityModule, ModuleType,
        IInterchainSecurityModuleDispatcher, IInterchainSecurityModuleDispatcherTrait,
        IMailboxDispatcher, IMailboxDispatcherTrait
    };
    use contracts::libs::message::{Message, MessageTrait};
    use core::panic_with_felt252;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};

    use starknet::{ContractAddress, ClassHash, contract_address_const};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);

    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    type Domain = u32;
    type Index = u32;

    #[storage]
    struct Storage {
        modules: LegacyMap<Domain, ContractAddress>,
        domains: LegacyMap<Domain, Domain>,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        mailboxclient: MailboxclientComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        MailboxclientEvent: MailboxclientComponent::Event,
    }

    mod Errors {
        pub const LENGTH_MISMATCH: felt252 = 'Length mismatch';
        pub const MODULE_CANNOT_BE_ZERO: felt252 = 'Module cannot be zero';
        pub const DOMAIN_NOT_FOUND: felt252 = 'Domain not found';
    }

    #[constructor]
    fn constructor(ref self: ContractState, _owner: ContractAddress, _mailbox: ContractAddress) {
        self.ownable.initializer(_owner);
        self.mailboxclient.initialize(_mailbox, Option::None, Option::None);
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
    impl IDomainRoutingIsmImpl of IDomainRoutingIsm<ContractState> {
        /// Initializes the contract with domains and ISMs
        /// Dev: Callable only by the owner
        /// Dev: Panics if domains and ISMs spans length mismatch or if module address is null
        /// 
        /// # Arguments
        ///
        /// * `_domains` - A span of origin domains
        /// * `_modules` - A span of module addresses associated to the domains
        fn initialize(
            ref self: ContractState, _domains: Span<u32>, _modules: Span<ContractAddress>
        ) {
            self.ownable.assert_only_owner();
            assert(_domains.len() == _modules.len(), Errors::LENGTH_MISMATCH);
            let mut cur_idx = 0;
            loop {
                if (cur_idx == _domains.len()) {
                    break ();
                }
                assert(
                    *_modules.at(cur_idx) != contract_address_const::<0>(),
                    Errors::MODULE_CANNOT_BE_ZERO
                );
                self._set(*_domains.at(cur_idx), *_modules.at(cur_idx));
                cur_idx += 1;
            }
        }

        /// Sets the ISM to be used for the specified origin domain
        /// 
        /// # Arguments
        /// 
        /// * - `_domain` - The origin domain
        /// * - `_module` -The ISM to use to verify messages
        fn set(ref self: ContractState, _domain: u32, _module: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(_module != contract_address_const::<0>(), Errors::MODULE_CANNOT_BE_ZERO);
            self._set(_domain, _module);
        }

        /// Removes the specified origin domain
        /// 
        /// # Arguments
        /// 
        /// * - `_domain` - The origin domain
        fn remove(ref self: ContractState, _domain: u32) {
            self.ownable.assert_only_owner();
            self._remove(_domain);
        }

        /// Builds a span of domains
        /// 
        /// # Returns
        /// 
        /// Span<u32> - a span of the stored domains
        fn domains(self: @ContractState) -> Span<u32> {
            let mut current_domain = self.domains.read(0);
            let mut domains = array![];
            loop {
                let next_domain = self.domains.read(current_domain);
                if next_domain == 0 {
                    domains.append(current_domain);
                    break ();
                }
                domains.append(current_domain);
                current_domain = next_domain;
            };
            domains.span()
        }

        /// Retrieve the module associated to a given origin
        /// 
        /// # Arguments
        /// 
        /// * - `_origin` - The origin domain
        /// 
        /// # Returns
        /// 
        /// ContractAddress - the module contract address
        fn module(self: @ContractState, _origin: u32) -> ContractAddress {
            let module = self.modules.read(_origin);
            if (module != contract_address_const::<0>()) {
                module
            } else {
                IMailboxDispatcher { contract_address: self.mailboxclient.mailbox() }
                    .get_default_ism()
            }
        }
    }

    #[abi(embed_v0)]
    impl IRoutingIsmImpl of IRoutingIsm<ContractState> {
        ///  Returns the ISM responsible for verifying _message
        /// Dev: Can change based on the content of _message
        /// 
        /// # Arguments
        /// 
        /// * - `_message` - message structure containing relevant information (see message.cairo)
        /// 
        /// # Returns 
        /// 
        /// ContractAddress - The ISM address to use to verify _message
        fn route(self: @ContractState, _message: Message) -> ContractAddress {
            self.module(_message.origin)
        }
    }

    #[abi(embed_v0)]
    impl IInterchainSecurityModuleImpl of IInterchainSecurityModule<ContractState> {
        fn module_type(self: @ContractState) -> ModuleType {
            ModuleType::ROUTING(starknet::get_contract_address())
        }


        /// Requires that m-of-n ISMs verify the provided interchain message.
        /// Dev: Can change based on the content of _message
        /// Dev: Reverts if threshold is not set
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded metadata 
        /// * - `_message` - message structure containing relevant information (see message.cairo)
        /// 
        /// # Returns 
        /// 
        /// boolean - wheter the verification succeed or not.
        fn verify(self: @ContractState, _metadata: Bytes, _message: Message) -> bool {
            let ism_address = self.route(_message.clone());
            let ism_dispatcher = IInterchainSecurityModuleDispatcher {
                contract_address: ism_address
            };
            ism_dispatcher.verify(_metadata, _message)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Removes the specified origin domain
        /// Dev: Callable only by the admin
        /// 
        /// # Arguments
        /// 
        /// * - `_domain` - The origin domain
        fn _remove(ref self: ContractState, _domain: u32) {
            let domain_index = match self.find_domain_index(_domain) {
                Option::Some(index) => index,
                Option::None => {
                    panic_with_felt252(Errors::DOMAIN_NOT_FOUND);
                    0
                }
            };
            let next_domain = self.domains.read(_domain);
            self.modules.write(_domain, contract_address_const::<0>());
            self.domains.write(domain_index, next_domain);
        }

        /// Sets the ISM to be used for the specified origin domain
        /// 
        /// # Arguments
        /// 
        /// * - `_domain` - The origin domain
        /// * - `_module` -The ISM to use to verify messages
        fn _set(ref self: ContractState, _domain: u32, _module: ContractAddress) {
            match self.find_domain_index(_domain) {
                Option::Some(_) => {},
                Option::None => {
                    let latest_domain = self.find_last_domain();
                    self.domains.write(latest_domain, _domain);
                }
            }
            self.modules.write(_domain, _module);
        }

        /// Helper: finds the last domain in the storage Legacy Map
        /// 
        /// # Returns 
        /// 
        /// u32 - the last domain stored
        fn find_last_domain(self: @ContractState) -> u32 {
            let mut current_domain = self.domains.read(0);
            loop {
                let next_domain = self.domains.read(current_domain);
                if next_domain == 0 {
                    break current_domain;
                }
                current_domain = next_domain;
            }
        }

        /// Retrieves the index for a given domain
        /// 
        /// # Arguments
        /// 
        /// * - `_domain` - The origin domain
        /// 
        /// # Returns
        /// 
        /// Option<u32> - the index if found, else None
        fn find_domain_index(self: @ContractState, _domain: u32) -> Option<u32> {
            let mut current_domain = 0;
            loop {
                let next_domain = self.domains.read(current_domain);
                if next_domain == _domain {
                    break Option::Some(current_domain);
                } else if next_domain == 0 {
                    break Option::None(());
                }
                current_domain = next_domain;
            }
        }
    }
}
