#[starknet::contract]
pub mod FastHypERC20 {
    use alexandria_bytes::Bytes;
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use contracts::utils::utils::U256TryIntoContractAddress;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use openzeppelin::upgrades::interface::IUpgradeable;
    use openzeppelin::upgrades::upgradeable::UpgradeableComponent;
    use starknet::ContractAddress;
    use token::components::{
        hyp_erc20_component::{HypErc20Component, HypErc20Component::TokenRouterHooksImpl},
        token_message::TokenMessageTrait,
        token_router::{
            TokenRouterComponent, TokenRouterComponent::TokenRouterHooksTrait,
            TokenRouterTransferRemoteHookDefaultImpl
        },
        fast_token_router::{
            FastTokenRouterComponent, FastTokenRouterComponent::FastTokenRouterHooksTrait,
            FastTokenRouterComponent::MessageRecipientInternalHookImpl
        }
    };

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailbox, event: MailBoxClientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(
        path: FastTokenRouterComponent, storage: fast_token_router, event: FastTokenRouterEvent
    );
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
    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;
    // ERC20
    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;
    // HypERC20
    #[abi(embed_v0)]
    impl HypErc20MetadataImpl =
        HypErc20Component::HypErc20MetadataImpl<ContractState>;
    impl HypErc20InternalImpl = HypErc20Component::InternalImpl<ContractState>;
    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
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
        hyp_erc20: HypErc20Component::Storage,
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
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
        FastTokenRouterEvent: FastTokenRouterComponent::Event,
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
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self.hyp_erc20.initialize(decimals);
        self
            .mailbox
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.erc20.initializer(name, symbol);
        self.erc20.mint(starknet::get_caller_address(), total_supply);
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
        /// This function mints tokens to the recipient as part of the fast token router process by calling
        /// the `mint` function of the ERC20 component.
        ///
        /// # Arguments
        ///
        /// * `recipient` - A `u256` representing the recipient's address.
        /// * `amount` - A `u256` representing the amount of tokens to mint.
        fn fast_transfer_to_hook(
            ref self: FastTokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount: u256
        ) {
            let mut contract_state = FastTokenRouterComponent::HasComponent::get_contract_mut(
                ref self
            );
            contract_state
                .erc20
                .mint(recipient.try_into().expect('u256 to ContractAddress failed'), amount);
        }

        /// Receives tokens from the sender as part of the fast token router process.
        ///
        /// This function burns tokens from the sender as part of the fast token router process by calling
        /// the `burn` function of the ERC20 component.
        ///
        /// # Arguments
        ///
        /// * `sender` - A `ContractAddress` representing the sender's address.
        /// * `amount` - A `u256` representing the amount of tokens to burn.
        fn fast_receive_from_hook(
            ref self: FastTokenRouterComponent::ComponentState<ContractState>,
            sender: ContractAddress,
            amount: u256
        ) {
            let mut contract_state = FastTokenRouterComponent::HasComponent::get_contract_mut(
                ref self
            );
            contract_state.erc20.burn(sender, amount);
        }
    }
}
