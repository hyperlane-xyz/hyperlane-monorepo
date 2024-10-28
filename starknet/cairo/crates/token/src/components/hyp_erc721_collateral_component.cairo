use starknet::ContractAddress;

#[starknet::interface]
pub trait IHypErc721Collateral<TState> {
    fn owner_of(self: @TState, token_id: u256) -> ContractAddress;
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn get_wrapped_token(self: @TState) -> ContractAddress;
}

#[starknet::component]
pub mod HypErc721CollateralComponent {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientInternalImpl,
        MailboxclientComponent::MailboxClient
    };
    use openzeppelin::access::ownable::{
        OwnableComponent, OwnableComponent::InternalImpl, OwnableComponent::OwnableImpl
    };
    use openzeppelin::token::erc721::interface::{ERC721ABIDispatcher, ERC721ABIDispatcherTrait};
    use starknet::ContractAddress;

    #[storage]
    struct Storage {
        wrapped_token: ERC721ABIDispatcher,
    }

    #[embeddable_as(HypErc721CollateralImpl)]
    impl HypErc721CollateralComponentImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        impl Mailboxclient: MailboxclientComponent::HasComponent<TContractState>,
    > of super::IHypErc721Collateral<ComponentState<TContractState>> {
        /// Returns the owner of a given ERC721 token ID.
        ///
        /// This function queries the wrapped ERC721 token contract to retrieve the address of the owner
        /// of the specified `token_id`.
        ///
        /// # Arguments
        ///
        /// * `token_id` - A `u256` representing the ID of the token whose owner is being queried.
        ///
        /// # Returns
        ///
        /// A `ContractAddress` representing the owner of the specified token.
        fn owner_of(self: @ComponentState<TContractState>, token_id: u256) -> ContractAddress {
            self.wrapped_token.read().owner_of(token_id)
        }

        /// Returns the balance of ERC721 tokens held by a given account.
        ///
        /// This function retrieves the number of ERC721 tokens held by the specified account by querying
        /// the wrapped ERC721 token contract.
        ///
        /// # Arguments
        ///
        /// * `account` - A `ContractAddress` representing the account whose balance is being queried.
        ///
        /// # Returns
        ///
        /// A `u256` representing the number of tokens held by the specified account.
        fn balance_of(self: @ComponentState<TContractState>, account: ContractAddress) -> u256 {
            self.wrapped_token.read().balance_of(account)
        }

        /// Returns the contract address of the wrapped ERC721 token.
        ///
        /// This function retrieves the contract address of the wrapped ERC721 token from the component's
        /// storage.
        ///
        /// # Returns
        ///
        /// A `ContractAddress` representing the address of the wrapped ERC721 token.
        fn get_wrapped_token(self: @ComponentState<TContractState>) -> ContractAddress {
            let wrapped_token: ERC721ABIDispatcher = self.wrapped_token.read();
            wrapped_token.contract_address
        }
    }
}
