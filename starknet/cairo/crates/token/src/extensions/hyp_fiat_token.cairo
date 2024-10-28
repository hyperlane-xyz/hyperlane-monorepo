#[starknet::contract]
pub mod HypFiatToken {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use contracts::utils::utils::U256TryIntoContractAddress;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::{
        hyp_erc20_collateral_component::HypErc20CollateralComponent,
        token_router::{
            TokenRouterComponent, TokenRouterComponent::TokenRouterHooksTrait,
            TokenRouterComponent::MessageRecipientInternalHookImpl,
            TokenRouterTransferRemoteHookDefaultImpl
        },
    };
    use token::interfaces::ifiat_token::{IFiatTokenDispatcher, IFiatTokenDispatcherTrait};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailbox, event: MailBoxClientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(
        path: HypErc20CollateralComponent, storage: collateral, event: HypErc20CollateralEvent
    );
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    // Ownable
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    // MailboxClient
    #[abi(embed_v0)]
    impl MailboxClientImpl =
        MailboxclientComponent::MailboxClientImpl<ContractState>;
    impl MailboxClientInternalImpl =
        MailboxclientComponent::MailboxClientInternalImpl<ContractState>;
    // Router
    #[abi(embed_v0)]
    impl RouterImpl = RouterComponent::RouterImpl<ContractState>;
    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;
    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
    impl TokenRouterInternalImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;

    // HypERC20Collateral
    #[abi(embed_v0)]
    impl HypErc20CollateralImpl =
        HypErc20CollateralComponent::HypErc20CollateralImpl<ContractState>;
    impl HypErc20CollateralInternalImpl =
        HypErc20CollateralComponent::HypErc20CollateralInternalImpl<ContractState>;
    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        collateral: HypErc20CollateralComponent::Storage,
        #[substorage(v0)]
        mailbox: MailboxclientComponent::Storage,
        #[substorage(v0)]
        token_router: TokenRouterComponent::Storage,
        #[substorage(v0)]
        gas_router: GasRouterComponent::Storage,
        #[substorage(v0)]
        router: RouterComponent::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        HypErc20CollateralEvent: HypErc20CollateralComponent::Event,
        #[flat]
        MailBoxClientEvent: MailboxclientComponent::Event,
        #[flat]
        GasRouterEvent: GasRouterComponent::Event,
        #[flat]
        RouterEvent: RouterComponent::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        TokenRouterEvent: TokenRouterComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        fiat_token: ContractAddress,
        mailbox: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.collateral.initialize(fiat_token);
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

    impl TokenRouterHooksImpl of TokenRouterHooksTrait<ContractState> {
        /// Transfers tokens from the sender and burns them.
        ///
        /// This hook transfers tokens from the sender and then burns the corresponding amount of the fiat token.
        /// It retrieves the token metadata and ensures that the correct amount is transferred from the sender.
        ///
        /// # Arguments
        ///
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        ///
        /// # Returns
        ///
        /// A `Bytes` object containing the metadata for the transfer.
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let metadata = contract_state.collateral._transfer_from_sender(amount_or_id);
            let token: ERC20ABIDispatcher = contract_state.collateral.wrapped_token.read();
            IFiatTokenDispatcher { contract_address: token.contract_address }.burn(amount_or_id);
            metadata
        }

        /// Transfers tokens to the recipient and mints new fiat tokens.
        ///
        /// This hook transfers tokens to the recipient and mints the corresponding amount of fiat tokens
        /// based on the provided amount or token ID. It ensures that the mint operation is successful.
        ///
        /// # Arguments
        ///
        /// * `recipient` - A `u256` representing the recipient's address.
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        /// * `metadata` - A `Bytes` object containing metadata associated with the transfer.
        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let token: ERC20ABIDispatcher = contract_state.collateral.wrapped_token.read();
            assert!(
                IFiatTokenDispatcher { contract_address: token.contract_address }
                    .mint(
                        recipient.try_into().expect('u256 to ContractAddress failed'), amount_or_id
                    ),
                "FiatToken mint failed"
            );
        }
    }
}

