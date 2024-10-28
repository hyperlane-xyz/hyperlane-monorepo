#[starknet::interface]
trait IMockHypERC721URIStorage<TContractState> {
    fn set_token_uri(ref self: TContractState, token_id: u256, uri: ByteArray);
}

#[starknet::contract]
pub mod MockHypERC721URIStorage {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::GasRouterComponent;
    use contracts::client::mailboxclient_component::MailboxclientComponent;
    use contracts::client::router_component::RouterComponent;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc721::{ERC721Component, ERC721HooksEmptyImpl};
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{ContractAddress, get_caller_address};
    use token::components::erc721_uri_storage::ERC721URIStorageComponent;
    use token::components::hyp_erc721_component::{HypErc721Component};
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterHooksTrait,
        TokenRouterComponent::MessageRecipientInternalHookImpl,
        TokenRouterTransferRemoteHookDefaultImpl
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);
    component!(path: RouterComponent, storage: router, event: RouterEvent);
    component!(path: GasRouterComponent, storage: gas_router, event: GasRouterEvent);
    component!(path: TokenRouterComponent, storage: token_router, event: TokenRouterEvent);
    component!(path: HypErc721Component, storage: hyp_erc721, event: HypErc721Event);
    component!(path: ERC721Component, storage: erc721, event: ERC721Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(
        path: ERC721URIStorageComponent, storage: erc721_uri_storage, event: ERC721UriStorageEvent
    );

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

    //Router
    #[abi(embed_v0)]
    impl RouterImpl = RouterComponent::RouterImpl<ContractState>;
    impl RouterInternalImpl = RouterComponent::RouterComponentInternalImpl<ContractState>;

    // GasRouter
    #[abi(embed_v0)]
    impl GasRouterImpl = GasRouterComponent::GasRouterImpl<ContractState>;

    // TokenRouter
    #[abi(embed_v0)]
    impl TokenRouterImpl = TokenRouterComponent::TokenRouterImpl<ContractState>;
    impl TokenRouterInternalImpl = TokenRouterComponent::TokenRouterInternalImpl<ContractState>;

    //HypERC721
    impl HypErc721InternalImpl = HypErc721Component::HypErc721InternalImpl<ContractState>;

    //ERC721
    #[abi(embed_v0)]
    impl ERC721URIStorageImpl =
        ERC721URIStorageComponent::ERC721URIStorageImpl<ContractState>;
    #[abi(embed_v0)]
    impl ERC721Impl = ERC721Component::ERC721Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC721CamelOnlyImpl = ERC721Component::ERC721CamelOnlyImpl<ContractState>;
    impl ERC721InternalImpl = ERC721Component::InternalImpl<ContractState>;
    impl ERC721URIStorageInternalImpl =
        ERC721URIStorageComponent::ERC721URIStorageInternalImpl<ContractState>;

    //upgradeable
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        mailboxclient: MailboxclientComponent::Storage,
        #[substorage(v0)]
        router: RouterComponent::Storage,
        #[substorage(v0)]
        gas_router: GasRouterComponent::Storage,
        #[substorage(v0)]
        token_router: TokenRouterComponent::Storage,
        #[substorage(v0)]
        hyp_erc721: HypErc721Component::Storage,
        #[substorage(v0)]
        erc721: ERC721Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        #[substorage(v0)]
        erc721_uri_storage: ERC721URIStorageComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        MailboxclientEvent: MailboxclientComponent::Event,
        #[flat]
        RouterEvent: RouterComponent::Event,
        #[flat]
        GasRouterEvent: GasRouterComponent::Event,
        #[flat]
        TokenRouterEvent: TokenRouterComponent::Event,
        #[flat]
        ERC721Event: ERC721Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        HypErc721Event: HypErc721Component::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        ERC721UriStorageEvent: ERC721URIStorageComponent::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        mailbox: ContractAddress,
        _mint_amount: u256,
        _name: ByteArray,
        _symbol: ByteArray,
        _hook: ContractAddress,
        _interchainSecurityModule: ContractAddress,
        owner: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        self
            .mailboxclient
            .initialize(mailbox, Option::Some(_hook), Option::Some(_interchainSecurityModule));
        self.hyp_erc721.initialize(_mint_amount, _name, _symbol);
    }

    #[abi(embed_v0)]
    impl IMockHypERC721URIStorageImpl of super::IMockHypERC721URIStorage<ContractState> {
        fn set_token_uri(ref self: ContractState, token_id: u256, uri: ByteArray) {
            self.erc721_uri_storage._set_token_uri(token_id, uri);
        }
    }

    #[abi(embed_v0)]
    impl HypErc721Upgradeable of IUpgradeable<ContractState> {
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
            assert!(token_owner == get_caller_address(), "Caller is not owner of token");

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

            let metadata_byteArray = bytes_to_byte_array(metadata);
            contract_state.erc721_uri_storage._set_token_uri(amount_or_id, metadata_byteArray);
            contract_state.erc721.mint(recipient, amount_or_id);
        }
    }

    // free function
    fn bytes_to_byte_array(self: Bytes) -> ByteArray {
        let mut res: ByteArray = Default::default();
        let mut offset = 0;
        while offset < self
            .size() {
                if offset + 31 <= self.size() {
                    let (new_offset, value) = self.read_bytes31(offset);
                    res.append_word(value.into(), 31);
                    offset = new_offset;
                } else {
                    let (new_offset, value) = self.read_u8(offset);
                    res.append_byte(value);
                    offset = new_offset;
                }
            };
        res
    }
}
