#[starknet::contract]
mod mailboxClientProxy {
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientInternalImpl
    };
    use openzeppelin::access::ownable::ownable::OwnableComponent::InternalTrait;
    use openzeppelin::access::ownable::{OwnableComponent,};
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{ContractAddress, ClassHash};
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl MailboxclientImpl =
        MailboxclientComponent::MailboxClientImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        mailboxclient: MailboxclientComponent::Storage,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        _mailbox: ContractAddress,
        _owner: ContractAddress,
        _hook: ContractAddress,
        _interchain_security_module: ContractAddress
    ) {
        self.ownable.initializer(_owner);
        self
            .mailboxclient
            .initialize(_mailbox, Option::Some(_hook), Option::Some(_interchain_security_module));
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        MailboxclientEvent: MailboxclientComponent::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
    }
    #[abi(embed_v0)]
    impl Upgradeable of IUpgradeable<ContractState> {
        /// Upgrades the contract to a new implementation.
        /// Callable only by the owner
        /// 
        /// # Arguments
        ///
        /// * `new_class_hash` - The class hash of the new implementation.
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }
}
