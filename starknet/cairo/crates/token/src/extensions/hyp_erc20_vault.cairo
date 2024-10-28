#[starknet::interface]
pub trait IHypErc20Vault<TContractState> {
    fn assets_to_shares(self: @TContractState, amount: u256) -> u256;
    fn shares_to_assets(self: @TContractState, shares: u256) -> u256;
    fn share_balance_of(self: @TContractState, account: starknet::ContractAddress) -> u256;
    // getters
    fn get_precision(self: @TContractState) -> u256;
    fn get_collateral_domain(self: @TContractState) -> u32;
    fn get_exchange_rate(self: @TContractState) -> u256;
}

#[starknet::contract]
mod HypErc20Vault {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::{
        RouterComponent, RouterComponent::IMessageRecipientInternalHookTrait
    };
    use contracts::libs::math;
    use core::zeroable::NonZero;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{
        ERC20Component, ERC20HooksEmptyImpl, interface::{IERC20, IERC20CamelOnly}
    };
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::{
        hyp_erc20_component::{HypErc20Component, HypErc20Component::TokenRouterHooksImpl,},
        token_router::{
            TokenRouterComponent,
            TokenRouterComponent::{TokenRouterHooksTrait, TokenRouterTransferRemoteHookTrait}
        }
    };

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailbox, event: MailBoxClientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(path: HypErc20Component, storage: hyp_erc20, event: HypErc20Event);
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
    // ERC20
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;
    // HypERC20
    #[abi(embed_v0)]
    impl HypErc20MetadataImpl =
        HypErc20Component::HypErc20MetadataImpl<ContractState>;
    impl HypErc20InternalImpl = HypErc20Component::InternalImpl<ContractState>;
    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // E10
    const E10: u256 = 10_000_000_000;
    const PRECISION: u256 = E10;

    #[storage]
    struct Storage {
        exchange_rate: u256,
        collateral_domain: u32,
        #[substorage(v0)]
        hyp_erc20: HypErc20Component::Storage,
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
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
        HypErc20Event: HypErc20Component::Event,
        #[flat]
        ERC20Event: ERC20Component::Event,
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
        decimals: u8,
        mailbox: ContractAddress,
        total_supply: u256,
        name: ByteArray,
        symbol: ByteArray,
        collateral_domain: u32,
        wrapped_token: ContractAddress,
        owner: ContractAddress,
        hook: ContractAddress,
        interchain_security_module: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.hyp_erc20.initialize(decimals);
        self.erc20.initializer(name, symbol);
        self.erc20.mint(starknet::get_caller_address(), total_supply);
        self.collateral_domain.write(collateral_domain);
        self.exchange_rate.write(E10);
    }

    impl TokenRouterTransferRemoteHookImpl of TokenRouterTransferRemoteHookTrait<ContractState> {
        /// Initiates a remote token transfer with optional hooks and metadata.
        ///
        /// This function handles the transfer of tokens to a recipient on a remote domain. It converts
        /// the token amount to shares, generates the token message, and dispatches the message to the
        /// specified destination. The transfer can optionally use a hook for additional processing.
        ///
        /// # Arguments
        ///
        /// * `destination` - A `u32` representing the destination domain.
        /// * `recipient` - A `u256` representing the recipient's address.
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
            let contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let shares = contract_state.assets_to_shares(amount_or_id);
            TokenRouterHooksImpl::transfer_from_sender_hook(ref self, shares);
            let token_message = TokenMessageTrait::format(
                recipient, shares, BytesTrait::new_empty()
            );
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

    #[abi(embed_v0)]
    impl HypeErc20Vault of super::IHypErc20Vault<ContractState> {
        // Converts a specified amount of assets to shares based on the current exchange rate.
        ///
        /// This function calculates the number of shares corresponding to the given amount of assets
        /// by using the exchange rate stored in the contract.
        ///
        /// # Arguments
        ///
        /// * `amount` - A `u256` representing the amount of assets to convert.
        ///
        /// # Returns
        ///
        /// A `u256` representing the number of shares equivalent to the given amount of assets.
        fn assets_to_shares(self: @ContractState, amount: u256) -> u256 {
            math::mul_div(amount, PRECISION, self.exchange_rate.read())
        }

        /// Converts a specified number of shares to assets based on the current exchange rate.
        ///
        /// This function calculates the number of assets corresponding to the given number of shares
        /// by using the exchange rate stored in the contract.
        ///
        /// # Arguments
        ///
        /// * `shares` - A `u256` representing the number of shares to convert.
        ///
        /// # Returns
        ///
        /// A `u256` representing the number of assets equivalent to the given number of shares.
        ///
        fn shares_to_assets(self: @ContractState, shares: u256) -> u256 {
            math::mul_div(shares, self.exchange_rate.read(), PRECISION)
        }

        /// Returns the balance of shares for the specified account.
        ///
        /// This function retrieves the number of shares owned by the given account. The shares are represented
        /// by the balance in the ERC20 component.
        ///
        /// # Arguments
        ///
        /// * `account` - A `ContractAddress` representing the account whose share balance is being queried.
        ///
        /// # Returns
        ///
        /// A `u256` representing the share balance of the specified account.
        fn share_balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }

        /// Returns the precision value used for calculations in the vault.
        ///
        /// This function returns the precision value applied to vault calculations, which is a constant
        /// defined in the contract.
        ///
        /// # Returns
        ///
        /// A `u256` representing the precision value.
        fn get_precision(self: @ContractState) -> u256 {
            PRECISION
        }

        /// Returns the collateral domain used by the vault.
        ///
        /// This function retrieves the collateral domain in which the vault operates, which is defined
        /// at the time of contract deployment.
        ///
        /// # Returns
        ///
        /// A `u32` representing the collateral domain.
        fn get_collateral_domain(self: @ContractState) -> u32 {
            self.collateral_domain.read()
        }

        /// Returns the current exchange rate between assets and shares.
        ///
        /// This function retrieves the current exchange rate used by the vault for converting assets
        /// to shares and vice versa.
        ///
        /// # Returns
        ///
        /// A `u256` representing the exchange rate.
        fn get_exchange_rate(self: @ContractState) -> u256 {
            self.exchange_rate.read()
        }
    }

    impl MessageRecipientInternalHookImpl of IMessageRecipientInternalHookTrait<ContractState> {
        /// Handles incoming messages and updates the exchange rate if necessary.
        ///
        /// This internal function processes messages received from remote domains. If the message
        /// is from the collateral domain, it updates the vault's exchange rate based on the metadata
        /// contained in the message.
        ///
        /// # Arguments
        ///
        /// * `origin` - A `u32` representing the origin domain of the message.
        /// * `sender` - A `u256` representing the sender of the message.
        /// * `message` - A `Bytes` object containing the message data.
        fn _handle(
            ref self: RouterComponent::ComponentState<ContractState>,
            origin: u32,
            sender: u256,
            message: Bytes
        ) {
            let mut contract_state = RouterComponent::HasComponent::get_contract_mut(ref self);
            if origin == contract_state.collateral_domain.read() {
                let (_, exchange_rate) = message.metadata().read_u256(0);
                contract_state.exchange_rate.write(exchange_rate);
            }
            TokenRouterComponent::MessageRecipientInternalHookImpl::_handle(
                ref self, origin, sender, message
            );
        }
    }

    #[abi(embed_v0)]
    impl ERC20VaultImpl of IERC20<ContractState> {
        fn total_supply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }

        // Overrides ERC20.balance_of()
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            let balance = self.erc20.balance_of(account);
            self.shares_to_assets(balance)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress
        ) -> u256 {
            self.erc20.allowance(owner, spender)
        }
        // Overrides ERC20.transfer()
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            self.erc20.transfer(recipient, self.assets_to_shares(amount));
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        ) -> bool {
            self.erc20.transfer_from(sender, recipient, amount)
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.erc20.approve(spender, amount)
        }
    }

    #[abi(embed_v0)]
    impl ERC20VaultCamelOnlyImpl of IERC20CamelOnly<ContractState> {
        fn totalSupply(self: @ContractState) -> u256 {
            self.erc20.totalSupply()
        }

        // Overrides ERC20.balanceOf()
        fn balanceOf(self: @ContractState, account: ContractAddress) -> u256 {
            let balance = self.erc20.balance_of(account);
            self.shares_to_assets(balance)
        }

        fn transferFrom(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        ) -> bool {
            self.erc20.transferFrom(sender, recipient, amount)
        }
    }
}
