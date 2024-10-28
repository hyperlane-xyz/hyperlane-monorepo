#[starknet::interface]
pub trait IHypErc20VaultCollateral<TContractState> {
    fn rebase(ref self: TContractState, destination_domain: u32, value: u256);
    // getters 
    fn get_vault(self: @TContractState) -> starknet::ContractAddress;
    fn get_precision(self: @TContractState) -> u256;
    fn get_null_recipient(self: @TContractState) -> u256;
}

#[starknet::contract]
mod HypErc20VaultCollateral {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use contracts::libs::math;
    use contracts::utils::utils::U256TryIntoContractAddress;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{ERC20ABIDispatcherTrait};
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::{
        token_router::{
            TokenRouterComponent, TokenRouterComponent::MessageRecipientInternalHookImpl,
            TokenRouterComponent::{TokenRouterHooksTrait, TokenRouterTransferRemoteHookTrait}
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
    impl RouterInternalImpl = RouterComponent::RouterComponentInternalImpl<ContractState>;
    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;
    impl GasRouterInternalImpl = GasRouterComponent::GasRouterInternalImpl<ContractState>;
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
    // E10
    const PRECISION: u256 = 10_000_000_000;
    const NULL_RECIPIENT: u256 = 1;

    #[storage]
    struct Storage {
        vault: ERC4626ABIDispatcher,
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
    }

    impl TokenRouterTransferRemoteHookImpl of TokenRouterTransferRemoteHookTrait<ContractState> {
        /// Initiates a remote token transfer with optional hooks and metadata.
        ///
        /// This function handles the process of transferring tokens to a recipient on a remote domain.
        /// It deposits the token amount into the vault, calculates the exchange rate, and appends it to the token metadata.
        /// The transfer is then dispatched to the specified destination domain using the provided hook and metadata.
        ///
        /// # Arguments
        ///
        /// * `destination` - A `u32` representing the destination domain.
        /// * `recipient` - A `u256` representing the recipient's address on the remote domain.
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        /// * `value` - A `u256` representing the value associated with the transfer.
        /// * `hook_metadata` - An optional `Bytes` object containing metadata for the hook.
        /// * `hook` - An optional `ContractAddress` representing the hook for additional processing.
        ///
        /// # Returns
        ///
        /// A `u256` representing the message ID of the dispatched transfer.
        fn _transfer_remote(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            value: u256,
            hook_metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256 {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            TokenRouterHooksTraitImpl::transfer_from_sender_hook(ref self, amount_or_id);
            let shares = contract_state._deposit_into_vault(amount_or_id);
            let vault = contract_state.vault.read();
            let exchange_rate = math::mul_div(
                PRECISION, vault.total_assets(), vault.total_supply(),
            );
            let mut token_metadata: Bytes = BytesTrait::new_empty();
            token_metadata.append_u256(exchange_rate);
            let token_message = TokenMessageTrait::format(recipient, shares, token_metadata);
            let mut message_id = 0;

            match hook_metadata {
                Option::Some(hook_metadata) => {
                    if !hook.is_some() {
                        panic!("Transfer remote invalid arguments, missing hook");
                    }

                    message_id = contract_state
                        .router
                        ._Router_dispatch(
                            destination, value, token_message, hook_metadata, hook.unwrap()
                        );
                },
                Option::None => {
                    let hook_metadata = contract_state
                        .gas_router
                        ._Gas_router_hook_metadata(destination);
                    let hook = contract_state.mailbox.get_hook();
                    message_id = contract_state
                        .router
                        ._Router_dispatch(destination, value, token_message, hook_metadata, hook);
                }
            }

            self
                .emit(
                    TokenRouterComponent::SentTransferRemote {
                        destination, recipient, amount: amount_or_id,
                    }
                );
            message_id
        }
    }

    impl TokenRouterHooksTraitImpl of TokenRouterHooksTrait<ContractState> {
        /// Transfers tokens from the sender and generates metadata.
        ///
        /// This hook is invoked during the transfer of tokens from the sender as part of the token router process.
        /// It generates metadata for the token transfer based on the amount or token ID provided and processes the
        /// transfer by depositing the amount into the vault.
        ///
        /// # Arguments
        ///
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        ///
        /// # Returns
        ///
        /// A `Bytes` object representing the metadata associated with the token transfer.
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            HypErc20CollateralComponent::TokenRouterHooksImpl::transfer_from_sender_hook(
                ref self, amount_or_id
            )
        }

        /// Processes a token transfer to a recipient.
        ///
        /// This hook handles the transfer of tokens to the recipient as part of the token router process. It withdraws
        /// the specified amount from the vault and transfers it to the recipient's address. The hook also processes any
        /// associated metadata.
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
            let recipient: ContractAddress = recipient.try_into().unwrap();
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            // withdraw with the specified amount of shares
            contract_state
                .vault
                .read()
                .redeem(
                    amount_or_id,
                    recipient.try_into().expect('u256 to ContractAddress failed'),
                    starknet::get_contract_address()
                );
        }
    }
    #[abi(embed_v0)]
    impl HypeErc20VaultCollateral of super::IHypErc20VaultCollateral<ContractState> {
        /// Rebases the vault collateral and sends a message to a remote domain.
        ///
        /// This function handles rebalancing the vault collateral by sending a rebase operation
        /// to the specified remote domain. It sends a message indicating the amount of the rebase
        /// without specifying a recipient (null recipient).
        ///
        /// # Arguments
        ///
        /// * `destination_domain` - A `u32` representing the destination domain to which the rebase message is sent.
        /// * `value` - A `u256` representing the value to be used for the rebase operation.
        fn rebase(ref self: ContractState, destination_domain: u32, value: u256) {
            TokenRouterTransferRemoteHookImpl::_transfer_remote(
                ref self.token_router,
                destination_domain,
                NULL_RECIPIENT,
                0,
                value,
                Option::None,
                Option::None,
            );
        }

        /// Returns the contract address of the vault.
        ///
        /// This function retrieves the vault's contract address where the ERC20 collateral is stored.
        ///
        /// # Returns
        ///
        /// A `ContractAddress` representing the vault's contract address.
        fn get_vault(self: @ContractState) -> ContractAddress {
            self.vault.read().contract_address
        }

        // Returns the precision value used for calculations in the vault.
        ///
        /// This function returns the precision value that is applied to the vault's calculations,
        /// which is a constant value.
        ///
        /// # Returns
        ///
        /// A `u256` representing the precision used in the vault.
        fn get_precision(self: @ContractState) -> u256 {
            PRECISION
        }

        /// Returns the null recipient used in rebase operations.
        ///
        /// This function retrieves the null recipient, which is a constant used in certain vault operations,
        /// particularly during rebase operations.
        ///
        /// # Returns
        ///
        /// A `u256` representing the null recipient.
        fn get_null_recipient(self: @ContractState) -> u256 {
            NULL_RECIPIENT
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

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _deposit_into_vault(ref self: ContractState, amount: u256) -> u256 {
            let vault = self.vault.read();
            self.collateral.wrapped_token.read().approve(vault.contract_address, amount);
            vault.deposit(amount, starknet::get_contract_address())
        }
    }
}
