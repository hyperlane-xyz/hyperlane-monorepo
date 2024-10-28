#[starknet::contract]
pub mod HypErc721Collateral {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc721::interface::{ERC721ABIDispatcher, ERC721ABIDispatcherTrait,};
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::hyp_erc721_collateral_component::{HypErc721CollateralComponent};
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterHooksTrait,
        TokenRouterComponent::MessageRecipientInternalHookImpl,
        TokenRouterTransferRemoteHookDefaultImpl
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(
        path: HypErc721CollateralComponent,
        storage: hyp_erc721_collateral,
        event: HypErc721CollateralEvent
    );
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    // HypERC721
    #[abi(embed_v0)]
    impl HypErc721CollateralImpl =
        HypErc721CollateralComponent::HypErc721CollateralImpl<ContractState>;

    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
    impl TokenRouterInternalImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;

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
    // Ownable
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        wrapped_token: ERC721ABIDispatcher,
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
        hyp_erc721_collateral: HypErc721CollateralComponent::Storage,
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
        HypErc721CollateralEvent: HypErc721CollateralComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        erc721: ContractAddress,
        mailbox: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailboxclient
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.wrapped_token.write(ERC721ABIDispatcher { contract_address: erc721 });
    }

    impl TokenRouterHooksImpl of TokenRouterHooksTrait<ContractState> {
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let contract_state = TokenRouterComponent::HasComponent::get_contract(@self);
            contract_state
                .wrapped_token
                .read()
                .transfer_from(
                    starknet::get_caller_address(), starknet::get_contract_address(), amount_or_id
                );

            BytesTrait::new_empty()
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let recipient_felt: felt252 = recipient.try_into().expect('u256 to felt failed');
            let recipient: ContractAddress = recipient_felt.try_into().unwrap();

            let metadata_array_u128 = metadata.data();
            let mut metadata_array_felt252: Array<felt252> = array![];

            let len = metadata_array_u128.len();
            let mut i = 0;
            while i < len {
                let metadata_felt252: felt252 = (*metadata_array_u128.at(i))
                    .try_into()
                    .expect('u128 to felt failed');
                metadata_array_felt252.append(metadata_felt252);
                i = i + 1;
            };

            contract_state
                .wrapped_token
                .read()
                .safe_transfer_from(
                    starknet::get_contract_address(),
                    recipient,
                    amount_or_id,
                    metadata_array_felt252.span()
                );
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
}
