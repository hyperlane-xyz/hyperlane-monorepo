use alexandria_bytes::Bytes;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IHypErc721<TState> {
    fn initialize(ref self: TState);
    fn balance_of(self: @TState) -> u256;
    fn handle(ref self: TState, origin: u32, sender: ContractAddress, message: Bytes);
}

#[starknet::contract]
pub mod HypErc721 {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc721::{ERC721Component, ERC721HooksEmptyImpl};
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::ContractAddress;
    use token::components::erc721_enumerable::ERC721EnumerableComponent;
    use token::components::hyp_erc721_component::HypErc721Component;
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, ITokenRouter, TokenRouterComponent::TokenRouterHooksTrait,
        TokenRouterComponent::MessageRecipientInternalHookImpl,
        TokenRouterTransferRemoteHookDefaultImpl
    };
    use token::interfaces::imessage_recipient::IMessageRecipient;
    // also needs {https://github.com/OpenZeppelin/cairo-contracts/blob/main/packages/token/src/erc721/extensions/erc721_enumerable/erc721_enumerable.cairo}
    component!(path: ERC721Component, storage: erc721, event: ERC721Event);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: HypErc721Component, storage: hyp_erc721, event: HypErc721Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(
        path: ERC721EnumerableComponent, storage: erc721_enumerable, event: ERC721EnumerableEvent
    );
    // ERC721 Mixin
    #[abi(embed_v0)]
    impl ERC721MixinImpl = ERC721Component::ERC721MixinImpl<ContractState>;
    impl ERC721InternalImpl = ERC721Component::InternalImpl<ContractState>;

    // ERC721Enumerable
    #[abi(embed_v0)]
    impl ERC721EnumerableImpl =
        ERC721EnumerableComponent::ERC721EnumerableImpl<ContractState>;
    // impl ERC721EnumerableInternalImpl = ERC721EnumerableComponent::InternalImpl<ContractState>;

    // Upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // HypERC721
    impl HypErc721InternalImpl = HypErc721Component::HypErc721InternalImpl<ContractState>;

    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
    impl TokenRouterInternalImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;

    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;
    impl GasRouterInternalImpl = GasRouterComponent::GasRouterInternalImpl<ContractState>;
    // Router
    #[abi(embed_v0)]
    impl RouterImpl = RouterComponent::RouterImpl<ContractState>;
    impl RouterInternalImpl = RouterComponent::RouterComponentInternalImpl<ContractState>;

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

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc721: ERC721Component::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        hyp_erc721: HypErc721Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
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
        erc721_enumerable: ERC721EnumerableComponent::Storage
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC721Event: ERC721Component::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        HypErc721Event: HypErc721Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
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
        ERC721EnumerableEvent: ERC721EnumerableComponent::Event
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        mailbox: ContractAddress,
        name: ByteArray,
        symbol: ByteArray,
        mint_amount: u256,
        hook: ContractAddress,
        interchain_security_module: ContractAddress,
        owner: ContractAddress
    ) {
        self.ownable.initializer(owner);
        self
            .mailboxclient
            .initialize(mailbox, Option::Some(hook), Option::Some(interchain_security_module));
        self.hyp_erc721.initialize(mint_amount, name, symbol);
    }

    #[abi(embed_v0)]
    impl HypErc721Upgradeable of IUpgradeable<ContractState> {
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
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>, amount_or_id: u256
        ) -> Bytes {
            let contract_state = TokenRouterComponent::HasComponent::get_contract(@self);
            let token_owner = contract_state.erc721.owner_of(amount_or_id);
            assert!(token_owner == starknet::get_caller_address(), "Caller is not owner");

            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state.erc721.burn(amount_or_id);

            BytesTrait::new_empty()
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<ContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let recipient_felt: felt252 = recipient.try_into().expect('u256 to felt failed');
            let recipient: ContractAddress = recipient_felt.try_into().unwrap();

            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            contract_state.erc721.mint(recipient, amount_or_id);
        }
    }
}

