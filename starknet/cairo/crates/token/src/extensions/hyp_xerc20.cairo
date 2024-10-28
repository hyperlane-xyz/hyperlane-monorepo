#[starknet::contract]
pub mod HypXERC20 {
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
    use token::components::hyp_erc20_collateral_component::HypErc20CollateralComponent;
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterHooksTrait,
        TokenRouterComponent::MessageRecipientInternalHookImpl,
        TokenRouterTransferRemoteHookDefaultImpl
    };
    use token::interfaces::ixerc20::{IXERC20Dispatcher, IXERC20DispatcherTrait};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailbox, event: MailBoxClientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(
        path: HypErc20CollateralComponent,
        storage: hyp_erc20_collateral,
        event: HypErc20CollateralEvent
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
    // HypERC20Collateral
    #[abi(embed_v0)]
    impl HypErc20CollateralImpl =
        HypErc20CollateralComponent::HypErc20CollateralImpl<ContractState>;
    impl HypErc20CollateralInternalImpl =
        HypErc20CollateralComponent::HypErc20CollateralInternalImpl<ContractState>;
    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;
    // Token Router
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        hyp_erc20_collateral: HypErc20CollateralComponent::Storage,
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
        mailbox: ContractAddress,
        wrapped_token: ContractAddress,
        owner: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.hyp_erc20_collateral.initialize(wrapped_token);
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
        /// Transfers tokens from the sender, burns the xERC20 tokens, and returns metadata.
        ///
        /// This hook transfers tokens from the sender, burns the corresponding xERC20 tokens, and returns any metadata
        /// associated with the transfer.
        ///
        /// # Arguments
        ///
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        ///
        /// # Returns
        ///
        /// A `Bytes` object representing the metadata associated with the transfer.
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let token: ERC20ABIDispatcher = contract_state
                .hyp_erc20_collateral
                .wrapped_token
                .read();
            IXERC20Dispatcher { contract_address: token.contract_address }
                .burn(starknet::get_caller_address(), amount_or_id);
            BytesTrait::new_empty()
        }

        /// Mints xERC20 tokens for the recipient and returns the transferred amount.
        ///
        /// This hook mints xERC20 tokens for the recipient based on the transferred amount of tokens and updates the
        /// corresponding ERC20 balances.
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
            let token: ERC20ABIDispatcher = contract_state
                .hyp_erc20_collateral
                .wrapped_token
                .read();
            IXERC20Dispatcher { contract_address: token.contract_address }
                .mint(recipient.try_into().unwrap(), amount_or_id);
        }
    }
}
