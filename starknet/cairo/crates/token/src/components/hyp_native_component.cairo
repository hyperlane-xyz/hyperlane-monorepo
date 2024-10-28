use starknet::ContractAddress;

#[starknet::interface]
pub trait IHypNative<TState> {
    // fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn receive(ref self: TState, amount: u256);
}

#[starknet::component]
pub mod HypNativeComponent {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::{
        GasRouterComponent,
        GasRouterComponent::{GasRouterInternalImpl, InternalTrait as GasRouterInternalTrait}
    };
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientImpl
    };
    use contracts::client::router_component::{
        RouterComponent,
        RouterComponent::{InternalTrait as RouterInternalTrait, RouterComponentInternalImpl}
    };
    use openzeppelin::access::ownable::{
        OwnableComponent, OwnableComponent::InternalImpl, OwnableComponent::OwnableImpl
    };
    use openzeppelin::token::erc20::{
        interface::{IERC20, ERC20ABIDispatcher, ERC20ABIDispatcherTrait}, ERC20Component
    };
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterInternalImpl,
        TokenRouterComponent::TokenRouterHooksTrait, ITokenRouter,
        TokenRouterTransferRemoteHookDefaultImpl
    };
    use token::interfaces::imessage_recipient::IMessageRecipient;


    #[storage]
    struct Storage {
        eth_token: ERC20ABIDispatcher,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Donation: Donation,
    }

    #[derive(Drop, starknet::Event)]
    struct Donation {
        sender: ContractAddress,
        amount: u256,
    }

    #[embeddable_as(HypNativeImpl)]
    impl HypNative<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +ERC20Component::HasComponent<TContractState>,
        impl Mailboxclient: MailboxclientComponent::HasComponent<TContractState>,
        impl TokenRouter: TokenRouterComponent::HasComponent<TContractState>,
    > of super::IHypNative<ComponentState<TContractState>> {
        fn receive(ref self: ComponentState<TContractState>, amount: u256) {
            self.eth_token.read().transfer(starknet::get_contract_address(), amount);

            self.emit(Donation { sender: starknet::get_caller_address(), amount });
        }
    }

    pub impl TokenRouterHooksImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterComponent::HasComponent<TContractState>,
        +ERC20Component::HasComponent<TContractState>
    > of TokenRouterHooksTrait<TContractState> {
        fn transfer_from_sender_hook(
            ref self: TokenRouterComponent::ComponentState<TContractState>, amount_or_id: u256
        ) -> Bytes {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let mut component_state = HasComponent::get_component_mut(ref contract_state);
            component_state._transfer_from_sender(amount_or_id)
        }

        fn transfer_to_hook(
            ref self: TokenRouterComponent::ComponentState<TContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            let mut contract_state = TokenRouterComponent::HasComponent::get_contract_mut(ref self);
            let mut component_state = HasComponent::get_component_mut(ref contract_state);
            component_state._transfer_to(recipient, amount_or_id);
        }
    }

    #[embeddable_as(TokenRouterImpl)]
    impl TokenRouter<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        impl MailboxClient: MailboxclientComponent::HasComponent<TContractState>,
        impl Router: RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        impl GasRouter: GasRouterComponent::HasComponent<TContractState>,
        impl TokenRouterComp: TokenRouterComponent::HasComponent<TContractState>,
        impl ERC20: ERC20Component::HasComponent<TContractState>
    > of ITokenRouter<ComponentState<TContractState>> {
        fn transfer_remote(
            ref self: ComponentState<TContractState>,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            value: u256,
            hook_metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256 {
            assert!(value >= amount_or_id, "Native: amount exceeds msg.value");
            let hook_payment = value - amount_or_id;

            let mut token_router_comp = get_dep_component_mut!(ref self, TokenRouterComp);
            TokenRouterTransferRemoteHookDefaultImpl::_transfer_remote(
                ref token_router_comp,
                destination,
                recipient,
                amount_or_id,
                hook_payment,
                Option::None,
                Option::None
            )
        }
    }

    #[generate_trait]
    pub impl HypNativeInternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +ERC20Component::HasComponent<TContractState>,
        impl Mailboxclient: MailboxclientComponent::HasComponent<TContractState>,
        impl TokenRouter: TokenRouterComponent::HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        fn _transfer_from_sender(ref self: ComponentState<TContractState>, amount: u256) -> Bytes {
            BytesTrait::new_empty()
        }

        fn _transfer_to(ref self: ComponentState<TContractState>, recipient: u256, amount: u256) {
            let contract_address = starknet::get_contract_address(); // this address or eth address
            let erc20_dispatcher = ERC20ABIDispatcher { contract_address };
            let recipient_felt: felt252 = recipient.try_into().expect('u256 to felt failed');
            let recipient: ContractAddress = recipient_felt.try_into().unwrap();
            erc20_dispatcher.transfer(recipient, amount);
        }
    }
}
