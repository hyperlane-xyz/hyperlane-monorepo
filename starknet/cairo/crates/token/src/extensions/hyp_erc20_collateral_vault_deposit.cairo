#[starknet::interface]
pub trait IHypERC20CollateralVaultDeposit<TState> {
    fn sweep(ref self: TState);
    // getters
    fn get_vault(self: @TState) -> starknet::ContractAddress;
    fn get_asset_deposited(self: @TState) -> u256;
}

#[starknet::contract]
pub mod HypERC20CollateralVaultDeposit {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use contracts::utils::utils::U256TryIntoContractAddress;
    use core::integer::BoundedInt;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{ERC20ABIDispatcherTrait};
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::{
        token_router::{
            TokenRouterComponent, TokenRouterComponent::MessageRecipientInternalHookImpl,
            TokenRouterComponent::TokenRouterHooksTrait, TokenRouterTransferRemoteHookDefaultImpl
        },
        hyp_erc20_collateral_component::HypErc20CollateralComponent,
    };
    use token::interfaces::ierc4626::{ERC4626ABIDispatcher, ERC4626ABIDispatcherTrait};

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
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
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
        vault: ERC4626ABIDispatcher,
        asset_deposited: u256,
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
        UpgradeableEvent: UpgradeableComponent::Event,
        ExcessSharesSwept: ExcessSharesSwept
    }

    #[derive(Drop, starknet::Event)]
    struct ExcessSharesSwept {
        amount: u256,
        assets_redeemed: u256
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        mailbox: ContractAddress,
        vault: ContractAddress,
        owner: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        let vault_dispatcher = ERC4626ABIDispatcher { contract_address: vault };
        let erc20 = vault_dispatcher.asset();
        self.collateral.initialize(erc20);
        self.vault.write(vault_dispatcher);
        self.collateral.wrapped_token.read().approve(vault, BoundedInt::max());
    }
    #[abi(embed_v0)]
    impl HypERC20CollateralVaultDepositImpl of super::IHypERC20CollateralVaultDeposit<
        ContractState
    > {
        /// Sweeps excess shares from the vault.
        ///
        /// This function checks for excess shares in the vault, which are shares that exceed the amount
        /// that was initially deposited. It redeems these excess shares and transfers the redeemed assets
        /// to the contract owner. The function emits an `ExcessSharesSwept` event after completing the sweep.
        fn sweep(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let this_address = starknet::get_contract_address();
            let vault = self.vault.read();
            let excess_shares = vault.max_redeem(this_address)
                - vault.convert_to_shares(self.asset_deposited.read());
            let assets_redeemed = vault
                .redeem(excess_shares, self.ownable.Ownable_owner.read(), this_address);
            self
                .emit(
                    ExcessSharesSwept { amount: excess_shares, assets_redeemed: assets_redeemed }
                );
        }

        /// Returns the contract address of the vault.
        ///
        /// This function retrieves the contract address of the vault that is being used for collateral
        /// deposits and withdrawals.
        ///
        /// # Returns
        ///
        /// A `ContractAddress` representing the vault's contract address.
        fn get_vault(self: @ContractState) -> ContractAddress {
            self.vault.read().contract_address
        }

        /// Returns the total amount of assets deposited in the vault.
        ///
        /// This function returns the total amount of assets that have been deposited into the vault by
        /// this contract.
        ///
        /// # Returns
        ///
        /// A `u256` representing the total assets deposited.
        fn get_asset_deposited(self: @ContractState) -> u256 {
            self.asset_deposited.read()
        }
    }

    impl TokenRouterHooksTraitImpl of TokenRouterHooksTrait<ContractState> {
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let metadata =
                HypErc20CollateralComponent::TokenRouterHooksImpl::transfer_from_sender_hook(
                ref self, amount_or_id
            );
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state._deposit_into_vault(amount_or_id);
            metadata
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state
                ._withdraw_from_vault(
                    amount_or_id, recipient.try_into().expect('u256 to ContractAddress failed')
                );
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Deposits the specified amount into the vault.
        ///
        /// This internal function deposits the specified amount of assets into the vault and updates the
        /// total amount of assets deposited by the contract.
        ///
        /// # Arguments
        ///
        /// * `amount` - A `u256` representing the amount of assets to deposit.
        fn _deposit_into_vault(ref self: ContractState, amount: u256) {
            let asset_deposited = self.asset_deposited.read();
            self.asset_deposited.write(asset_deposited + amount);
            self.vault.read().deposit(amount, starknet::get_contract_address());
        }

        // Returns the total amount of assets deposited in the vault.
        ///
        /// This function returns the total amount of assets that have been deposited into the vault by
        /// this contract.
        ///
        /// # Returns
        ///
        /// A `u256` representing the total assets deposited.
        fn _withdraw_from_vault(ref self: ContractState, amount: u256, recipient: ContractAddress) {
            let asset_deposited = self.asset_deposited.read();
            self.asset_deposited.write(asset_deposited - amount);
            self.vault.read().withdraw(amount, recipient, starknet::get_contract_address());
        }
    }
}
