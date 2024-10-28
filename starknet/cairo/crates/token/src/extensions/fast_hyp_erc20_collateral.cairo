#[starknet::interface]
pub trait IFastHypERC20<TState> {
    fn balance_of(self: @TState, account: starknet::ContractAddress) -> u256;
}

#[starknet::contract]
pub mod FastHypERC20Collateral {
    use alexandria_bytes::Bytes;
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
        hyp_erc20_collateral_component::{
            HypErc20CollateralComponent, HypErc20CollateralComponent::TokenRouterHooksImpl
        },
        token_message::TokenMessageTrait,
        token_router::{TokenRouterComponent, TokenRouterTransferRemoteHookDefaultImpl},
        fast_token_router::{
            FastTokenRouterComponent, FastTokenRouterComponent::FastTokenRouterHooksTrait,
            FastTokenRouterComponent::MessageRecipientInternalHookImpl
        }
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailbox, event: MailBoxClientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(
        path: FastTokenRouterComponent, storage: fast_token_router, event: FastTokenRouterEvent
    );
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
    // HypERC20Collateral
    #[abi(embed_v0)]
    impl HypErc20CollateralImpl =
        HypErc20CollateralComponent::HypErc20CollateralImpl<ContractState>;
    impl HypErc20CollateralInternalImpl =
        HypErc20CollateralComponent::HypErc20CollateralInternalImpl<ContractState>;
    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
    impl TokenRouterInternalImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;
    // FastTokenRouter
    #[abi(embed_v0)]
    impl FastTokenRouterImpl =
        FastTokenRouterComponent::FastTokenRouterImpl<ContractState>;
    impl FastTokenRouterInternalImpl = FastTokenRouterComponent::InternalImpl<ContractState>;
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
        fast_token_router: FastTokenRouterComponent::Storage,
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
        FastTokenRouterEvent: FastTokenRouterComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        mailbox: ContractAddress,
        wrapped_token: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.collateral.initialize(wrapped_token);
    }

    impl FastHypERC20Impl of super::IFastHypERC20<ContractState> {
        /// Returns the balance of the specified account for the wrapped ERC20 token.
        ///
        /// This function retrieves the balance of the wrapped ERC20 token for a given account by calling
        /// the `balance_of` function on the `HypErc20CollateralComponent`.
        ///
        /// # Arguments
        ///
        /// * `account` - A `ContractAddress` representing the account whose token balance is being queried.
        ///
        /// # Returns
        ///
        /// A `u256` representing the balance of the specified account.
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.collateral.balance_of(account)
        }
    }

    #[abi(embed_v0)]
    impl UpgradeableImpl of IUpgradeable<ContractState> {
        /// Upgrades the contract to a new implementation.
        /// Callable only by the owner
        /// # Arguments
        ///
        /// * `new_class_hash` - The class hash of the new implementation.
        fn upgrade(ref self: ContractState, new_class_hash: core::starknet::ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    pub impl FastTokenRouterHooksImpl of FastTokenRouterHooksTrait<ContractState> {
        /// Transfers tokens to the recipient as part of the fast token router process.
        ///
        /// This function handles the fast token transfer process by invoking the `transfer` method of the
        /// wrapped token from the `HypErc20CollateralComponent`. The recipient receives the transferred amount.
        ///
        /// # Arguments
        ///
        /// * `recipient` - A `u256` representing the recipient's address.
        /// * `amount` - A `u256` representing the amount of tokens to transfer.
        fn fast_transfer_to_hook(
            ref self: FastTokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount: u256
        ) {
            let mut contract_state = FastTokenRouterComponent::HasComponent::get_contract_mut(
                ref self
            );
            contract_state
                .collateral
                .wrapped_token
                .read()
                .transfer(recipient.try_into().expect('u256 to ContractAddress failed'), amount);
        }

        /// Receives tokens from the sender as part of the fast token router process.
        ///
        /// This function handles the receipt of tokens from the sender by calling the `transfer_from` method
        /// of the wrapped token within the `HypErc20CollateralComponent`.
        ///
        /// # Arguments
        ///
        /// * `sender` - A `ContractAddress` representing the sender's address.
        /// * `amount` - A `u256` representing the amount of tokens to receive.
        fn fast_receive_from_hook(
            ref self: FastTokenRouterComponent::ComponentState<ContractState>,
            sender: ContractAddress,
            amount: u256
        ) {
            let mut contract_state = FastTokenRouterComponent::HasComponent::get_contract_mut(
                ref self
            );
            contract_state
                .collateral
                .wrapped_token
                .read()
                .transfer_from(sender, starknet::get_contract_address(), amount);
        }
    }
}
