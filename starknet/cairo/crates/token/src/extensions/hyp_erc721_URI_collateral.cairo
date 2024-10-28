#[starknet::interface]
pub trait IHypERC721URICollateral<TState> {
    fn initialize(ref self: TState);
    fn owner_of(self: @TState, token_id: u256) -> u256;
    fn balance_of(self: @TState, account: u256) -> u256;
}

#[starknet::contract]
pub mod HypERC721URICollateral {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc721::interface::{ERC721ABIDispatcher, ERC721ABIDispatcherTrait,};
    use starknet::ContractAddress;
    use token::components::hyp_erc721_collateral_component::{
        HypErc721CollateralComponent, IHypErc721Collateral
    };
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
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;


    #[storage]
    struct Storage {
        erc721: ContractAddress,
        mailbox: ContractAddress,
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
        hyp_erc721_collateral: HypErc721CollateralComponent::Storage
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
        HypErc721CollateralEvent: HypErc721CollateralComponent::Event
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        erc721: ContractAddress,
        mailbox: ContractAddress,
        hook: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self.mailboxclient.initialize(mailbox, Option::Some(hook), Option::None);

        self
            .hyp_erc721_collateral
            .wrapped_token
            .write(ERC721ABIDispatcher { contract_address: erc721 });
    }

    impl TokenRouterHooksImpl of TokenRouterHooksTrait<ContractState> {
        /// Transfers the token from the sender and retrieves its metadata.
        ///
        /// This hook handles the transfer of a token from the sender and appends its URI to the metadata.
        /// It retrieves the token URI from the ERC721 contract and appends it to the metadata for processing
        /// as part of the transfer message.
        ///
        /// # Arguments
        ///
        /// * `amount_or_id` - A `u256` representing the token ID being transferred.
        ///
        /// # Returns
        ///
        /// A `Bytes` object containing the token's URI as metadata.
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state
                .hyp_erc721_collateral
                .wrapped_token
                .read()
                .transfer_from(
                    starknet::get_caller_address(), starknet::get_contract_address(), amount_or_id
                );

            let uri = contract_state
                .hyp_erc721_collateral
                .wrapped_token
                .read()
                .token_uri(amount_or_id);

            let mut metadata = BytesTrait::new_empty();

            let len = uri.len();
            let mut i = 0;
            while i < len {
                metadata.append_u8(uri.at(i).expect('Invalid metadata'));
                i += 1;
            };

            metadata
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {}
    }
}
