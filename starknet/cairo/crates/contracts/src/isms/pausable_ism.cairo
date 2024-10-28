#[starknet::interface]
pub trait IPausableIsm<TContractState> {
    fn pause(ref self: TContractState);

    fn unpause(ref self: TContractState);
}


#[starknet::contract]
pub mod pausable_ism {
    use alexandria_bytes::Bytes;
    use contracts::interfaces::{
        ModuleType, IInterchainSecurityModule, IInterchainSecurityModuleDispatcher,
        IInterchainSecurityModuleDispatcherTrait
    };
    use contracts::libs::message::{Message, MessageTrait};
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::security::pausable::PausableComponent;
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{ContractAddress, ClassHash};
    use super::{IPausableIsm, IPausableIsmDispatcher, IPausableIsmDispatcherTrait,};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);

    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;


    #[storage]
    struct Storage {
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, _owner: ContractAddress) {
        self.ownable.initializer(_owner);
    }

    #[abi(embed_v0)]
    impl IInterchainSecurityModuleImpl of IInterchainSecurityModule<ContractState> {
        fn module_type(self: @ContractState) -> ModuleType {
            ModuleType::NULL(())
        }

        /// Requires that m-of-n ISMs verify the provided interchain message.
        /// Dev: Can change based on the content of _message
        /// Dev: Reverts if threshold is not set
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded metadata (see aggregation_ism_metadata.cairo)
        /// * - `_message` - message structure containing relevant information (see message.cairo)
        /// 
        /// # Returns 
        /// 
        /// boolean - wheter the verification succeed or not.
        fn verify(self: @ContractState, _metadata: Bytes, _message: Message) -> bool {
            self.pausable.assert_not_paused();
            true
        }
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
    impl IPausableIsmImpl of IPausableIsm<ContractState> {
        fn pause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.unpause();
        }
    }
}
