use starknet::ContractAddress;

#[starknet::component]
pub mod HypErc20Component {
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
    use openzeppelin::token::erc20::ERC20Component;
    use openzeppelin::token::erc20::{
        ERC20Component::{InternalImpl as ERC20InternalImpl, ERC20HooksTrait},
        interface::IERC20Metadata,
    };

    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterInternalImpl,
        TokenRouterComponent::TokenRouterHooksTrait
    };

    #[storage]
    struct Storage {
        decimals: u8,
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
        +ERC20HooksTrait<TContractState>,
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

    #[embeddable_as(HypErc20MetadataImpl)]
    impl HypErc20Metadata<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterComponent::HasComponent<TContractState>,
        +ERC20HooksTrait<TContractState>,
        impl ERC20: ERC20Component::HasComponent<TContractState>
    > of IERC20Metadata<ComponentState<TContractState>> {
        /// Returns the name of the ERC20 token.
        ///
        /// This function retrieves the name of the token by reading from the `ERC20_name` field
        /// of the ERC20 component.
        ///
        /// # Returns
        ///
        /// A `ByteArray` representing the name of the token.
        fn name(self: @ComponentState<TContractState>) -> ByteArray {
            let erc20 = get_dep_component!(self, ERC20);
            erc20.ERC20_name.read()
        }

        /// Returns the symbol of the ERC20 token.
        ///
        /// This function retrieves the symbol, or ticker, of the token by reading from the `ERC20_symbol`
        /// field of the ERC20 component.
        ///
        /// # Returns
        ///
        /// A `ByteArray` representing the token's symbol.
        fn symbol(self: @ComponentState<TContractState>) -> ByteArray {
            let erc20 = get_dep_component!(self, ERC20);
            erc20.ERC20_symbol.read()
        }

        /// Returns the number of decimals used to represent the token.
        ///
        /// This function returns the number of decimals defined for the token, which represents the
        /// smallest unit of the token used in its user-facing operations. The value is read from the
        /// `decimals` field of the component's storage.
        ///
        /// # Returns
        ///
        /// A `u8` representing the number of decimals used by the token.
        fn decimals(self: @ComponentState<TContractState>) -> u8 {
            self.decimals.read()
        }
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterComponent::HasComponent<TContractState>,
        +ERC20HooksTrait<TContractState>,
        impl ERC20: ERC20Component::HasComponent<TContractState>
    > of InternalTrait<TContractState> {
        /// Initializes the token with a specific number of decimals.
        ///
        /// This function sets the `decimals` value for the token during the initialization phase, defining
        /// how many decimal places the token will support.
        ///
        /// # Arguments
        ///
        /// * `decimals` - A `u8` value representing the number of decimals for the token.
        fn initialize(ref self: ComponentState<TContractState>, decimals: u8) {
            self.decimals.write(decimals);
        }

        /// Burns tokens from the sender's account.
        ///
        /// This function transfers the specified amount of tokens from the sender's account by
        /// calling the `burn` function on the ERC20 component.
        ///
        /// # Arguments
        ///
        /// * `amount` - A `u256` value representing the amount of tokens to be burned.
        ///
        /// # Returns
        ///
        /// A `Bytes` object representing an empty payload.
        fn _transfer_from_sender(ref self: ComponentState<TContractState>, amount: u256) -> Bytes {
            let mut erc20 = get_dep_component_mut!(ref self, ERC20);
            erc20.burn(starknet::get_caller_address(), amount);
            BytesTrait::new_empty()
        }

        /// Mints tokens to the specified recipient.
        ///
        /// This function mints new tokens and transfers them to the recipient's account by calling
        /// the `mint` function on the ERC20 component.
        ///
        /// # Arguments
        ///
        /// * `recipient` - A `u256` value representing the recipient's address.
        /// * `amount` - A `u256` value representing the amount of tokens to mint.
        fn _transfer_to(ref self: ComponentState<TContractState>, recipient: u256, amount: u256) {
            let mut erc20 = get_dep_component_mut!(ref self, ERC20);
            erc20.mint(recipient.try_into().expect('u256 to ContractAddress failed'), amount);
        }
    }
}
