use starknet::ContractAddress;

#[starknet::interface]
pub trait IHypErc20Collateral<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn get_wrapped_token(self: @TState) -> ContractAddress;
}

#[starknet::component]
pub mod HypErc20CollateralComponent {
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
    use contracts::interfaces::IMailboxClient;
    use contracts::utils::utils::{U256TryIntoContractAddress};

    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterInternalImpl,
        TokenRouterComponent::TokenRouterHooksTrait
    };

    #[storage]
    struct Storage {
        wrapped_token: ERC20ABIDispatcher
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

    #[embeddable_as(HypErc20CollateralImpl)]
    impl HypeErc20CollateralComponentImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterComponent::HasComponent<TContractState>,
    > of super::IHypErc20Collateral<ComponentState<TContractState>> {
        /// Returns the balance of the given account for the wrapped ERC20 token.
        ///
        /// This function retrieves the balance of the wrapped ERC20 token for a specified account by calling the
        /// `balance_of` function on the wrapped token dispatcher.
        ///
        /// # Arguments
        ///
        /// * `account` - A `ContractAddress` representing the account whose balance is being queried.
        ///
        /// # Returns
        ///
        /// A `u256` representing the balance of the specified account.
        fn balance_of(self: @ComponentState<TContractState>, account: ContractAddress) -> u256 {
            self.wrapped_token.read().balance_of(account)
        }

        /// Returns the contract address of the wrapped ERC20 token.
        ///
        /// This function retrieves the contract address of the wrapped ERC20 token from the token dispatcher.
        ///
        /// # Returns
        ///
        /// A `ContractAddress` representing the address of the wrapped ERC20 token.
        fn get_wrapped_token(self: @ComponentState<TContractState>) -> ContractAddress {
            let wrapped_token: ERC20ABIDispatcher = self.wrapped_token.read();
            wrapped_token.contract_address
        }
    }

    #[generate_trait]
    pub impl HypErc20CollateralInternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterComponent::HasComponent<TContractState>,
        impl Mailboxclient: MailboxclientComponent::HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        fn initialize(ref self: ComponentState<TContractState>, wrapped_token: ContractAddress) {
            self.wrapped_token.write(ERC20ABIDispatcher { contract_address: wrapped_token });
        }

        fn _transfer_from_sender(ref self: ComponentState<TContractState>, amount: u256) -> Bytes {
            self
                .wrapped_token
                .read()
                .transfer_from(
                    starknet::get_caller_address(), starknet::get_contract_address(), amount
                );
            BytesTrait::new_empty()
        }

        fn _transfer_to(ref self: ComponentState<TContractState>, recipient: u256, amount: u256) {
            self
                .wrapped_token
                .read()
                .transfer(recipient.try_into().expect('u256 to ContractAddress failed'), amount);
        }
    }
}
