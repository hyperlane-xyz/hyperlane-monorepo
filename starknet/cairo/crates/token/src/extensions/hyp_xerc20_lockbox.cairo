#[starknet::interface]
pub trait IHypXERC20Lockbox<TState> {
    fn approve_lockbox(ref self: TState);
    fn lockbox(ref self: TState) -> starknet::ContractAddress;
    fn xERC20(ref self: TState) -> starknet::ContractAddress;
}

#[starknet::contract]
pub mod HypXERC20Lockbox {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use contracts::utils::utils::U256TryIntoContractAddress;
    use core::integer::BoundedInt;
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
    use token::interfaces::ixerc20::{IXERC20Dispatcher, IXERC20DispatcherTrait};
    use token::interfaces::ixerc20_lockbox::{
        IXERC20LockboxDispatcher, IXERC20LockboxDispatcherTrait
    };

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
        upgradeable: UpgradeableComponent::Storage,
        lockbox: IXERC20LockboxDispatcher,
        xerc20: IXERC20Dispatcher,
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
        lockbox: ContractAddress,
        owner: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        let lockbox_dispatcher = IXERC20LockboxDispatcher { contract_address: lockbox };
        let erc20 = lockbox_dispatcher.erc20();
        self.collateral.initialize(erc20);
        let xerc20 = lockbox_dispatcher.xerc20();
        self.xerc20.write(IXERC20Dispatcher { contract_address: xerc20 });
        self.lockbox.write(lockbox_dispatcher);
        self.approve_lockbox();
    }

    #[abi(embed_v0)]
    impl HypXERC20LockboxImpl of super::IHypXERC20Lockbox<ContractState> {
        /// Approves the lockbox for both the ERC20 and xERC20 tokens.
        ///
        /// This function approves the lockbox contract to handle the maximum allowed amount of both the ERC20 and xERC20 tokens.
        /// It ensures that both the ERC20 and xERC20 tokens are authorized for transfer to the lockbox.
        fn approve_lockbox(ref self: ContractState) {
            let lockbox_address = self.lockbox.read().contract_address;
            assert!(
                self.collateral.wrapped_token.read().approve(lockbox_address, BoundedInt::max()),
                "erc20 lockbox approve failed"
            );
            assert!(
                ERC20ABIDispatcher { contract_address: self.xerc20.read().contract_address }
                    .approve(lockbox_address, BoundedInt::max()),
                "xerc20 lockbox approve failed"
            );
        }

        /// Retrieves the contract address of the lockbox.
        ///
        /// This function returns the `ContractAddress` of the lockbox that has been approved for the ERC20 and xERC20 tokens.
        ///
        /// # Returns
        ///
        /// The `ContractAddress` of the lockbox.
        fn lockbox(ref self: ContractState) -> ContractAddress {
            self.lockbox.read().contract_address
        }

        /// Retrieves the contract address of the xERC20 token.
        ///
        /// This function returns the `ContractAddress` of the xERC20 token that is used in conjunction with the lockbox.
        ///
        /// # Returns
        ///
        /// The `ContractAddress` of the xERC20 token.
        fn xERC20(ref self: ContractState) -> ContractAddress {
            self.xerc20.read().contract_address
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

    impl TokenRouterHooksImpl of TokenRouterHooksTrait<ContractState> {
        /// Transfers tokens from the sender, deposits them into the lockbox, and burns the corresponding xERC20 tokens.
        ///
        /// This hook first transfers tokens from the sender, deposits them into the lockbox, and then burns the
        /// corresponding xERC20 tokens associated with the transfer.
        ///
        /// # Arguments
        ///
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        ///
        /// # Returns
        ///
        /// A `Bytes` object representing the transfer metadata.
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state.collateral._transfer_from_sender(amount_or_id);

            contract_state.lockbox.read().deposit(amount_or_id);

            contract_state.xerc20.read().burn(starknet::get_contract_address(), amount_or_id);
            BytesTrait::new_empty()
        }

        /// Transfers tokens to the recipient, mints xERC20 tokens, and withdraws tokens from the lockbox.
        ///
        /// This hook first mints the corresponding xERC20 tokens and then withdraws the corresponding amount
        /// of ERC20 tokens from the lockbox to the specified recipient.
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

            contract_state.xerc20.read().mint(starknet::get_contract_address(), amount_or_id);
            contract_state.lockbox.read().withdraw_to(recipient, amount_or_id);
        }
    }
}

