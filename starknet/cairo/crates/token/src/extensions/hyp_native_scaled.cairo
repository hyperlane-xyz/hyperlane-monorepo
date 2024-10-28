#[starknet::interface]
trait IHypNativeScaled<TState> {
    fn get_scale(self: @TState) -> u256;
}

#[starknet::contract]
pub mod HypNativeScaled {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{
        interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait}, ERC20Component,
        ERC20HooksEmptyImpl
    };
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::hyp_native_component::{HypNativeComponent};
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, ITokenRouter, TokenRouterComponent::TokenRouterHooksTrait,
        TokenRouterComponent::MessageRecipientInternalHookImpl,
        TokenRouterTransferRemoteHookDefaultImpl
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: HypNativeComponent, storage: hyp_native, event: HypNativeEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    // ERC20
    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20MixinImpl<ContractState>;
    // Ownable
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    // HypNative
    #[abi(embed_v0)]
    impl HypNativeImpl = HypNativeComponent::HypNativeImpl<ContractState>;
    #[abi(embed_v0)]
    impl HypNativeTokenRouterImpl =
        HypNativeComponent::TokenRouterImpl<ContractState>;
    impl HypNativeInternalImpl = HypNativeComponent::HypNativeInternalImpl<ContractState>;
    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;
    // Router
    #[abi(embed_v0)]
    impl RouterImpl = RouterComponent::RouterImpl<ContractState>;
    // MailboxClient
    #[abi(embed_v0)]
    impl MailboxClientImpl =
        MailboxclientComponent::MailboxClientImpl<ContractState>;
    impl MailboxClientInternalImpl =
        MailboxclientComponent::MailboxClientInternalImpl<ContractState>;
    // TokenRouter
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;
    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        scale: u256,
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        token_router: TokenRouterComponent::Storage,
        #[substorage(v0)]
        mailboxclient: MailboxclientComponent::Storage,
        #[substorage(v0)]
        router: RouterComponent::Storage,
        #[substorage(v0)]
        gas_router: GasRouterComponent::Storage,
        #[substorage(v0)]
        hyp_native: HypNativeComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        TokenRouterEvent: TokenRouterComponent::Event,
        #[flat]
        MailboxclientEvent: MailboxclientComponent::Event,
        #[flat]
        RouterEvent: RouterComponent::Event,
        #[flat]
        GasRouterEvent: GasRouterComponent::Event,
        #[flat]
        HypNativeEvent: HypNativeComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, owner: ContractAddress, scale: u256, mailbox: ContractAddress
    ) {
        self.mailboxclient.initialize(mailbox, Option::None, Option::None);
        self.ownable.initializer(owner);
        self.scale.write(scale);
    }

    impl HypNativeScaled of super::IHypNativeScaled<ContractState> {
        fn get_scale(self: @ContractState) -> u256 {
            self.scale.read()
        }
    }

    #[abi(embed_v0)]
    impl UpgradeableImpl of IUpgradeable<ContractState> {
        /// Upgrades the contract to a new implementation.
        /// Callable only by the owner
        /// # Arguments
        ///
        /// * `new_class_hash` - The class hash of the new implementation.
        fn upgrade(ref self: ContractState, new_class_hash: starknet::ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    #[embeddable_as(TokenRouterImpl)]
    impl TokenRouter of ITokenRouter<ContractState> {
        fn transfer_remote(
            ref self: ContractState,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            value: u256,
            hook_metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256 {
            let hook_payment = value - amount_or_id;
            let scaled_amount = amount_or_id / self.scale.read();
            TokenRouterTransferRemoteHookDefaultImpl::_transfer_remote(
                ref self.token_router,
                destination,
                recipient,
                scaled_amount,
                hook_payment,
                Option::None,
                Option::None
            )
        }
    }

    impl TokenRouterHooksImpl of TokenRouterHooksTrait<ContractState> {
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            BytesTrait::new_empty()
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let scaled_amount = amount_or_id * contract_state.scale.read();
            contract_state.hyp_native._transfer_to(recipient, scaled_amount);
        }
    }
}
