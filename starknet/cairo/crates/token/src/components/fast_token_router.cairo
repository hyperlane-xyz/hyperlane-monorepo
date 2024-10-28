#[starknet::interface]
pub trait IFastTokenRouter<TState> {
    fn fill_fast_transfer(
        ref self: TState,
        recipient: u256,
        amount: u256,
        fast_fee: u256,
        origin: u32,
        fast_transfer_id: u256
    );
    fn fast_transfer_remote(
        ref self: TState,
        destination: u32,
        recipient: u256,
        amount_or_id: u256,
        fast_fee: u256,
        value: u256
    ) -> u256;
}

#[starknet::component]
pub mod FastTokenRouterComponent {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::client::gas_router_component::{
        GasRouterComponent, GasRouterComponent::GasRouterInternalImpl
    };
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientInternalImpl,
        MailboxclientComponent::MailboxClient
    };
    use contracts::client::router_component::{
        RouterComponent, RouterComponent::RouterComponentInternalImpl,
        RouterComponent::IMessageRecipientInternalHookTrait, IRouter
    };
    use contracts::utils::utils::U256TryIntoContractAddress;
    use openzeppelin::access::ownable::{
        OwnableComponent, OwnableComponent::InternalImpl as OwnableInternalImpl
    };
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;
    use token::components::token_router::{
        TokenRouterComponent, TokenRouterComponent::TokenRouterInternalImpl,
        TokenRouterComponent::TokenRouterHooksTrait
    };

    #[storage]
    struct Storage {
        fast_transfer_id: u256,
        filled_fast_transfers: LegacyMap<u256, ContractAddress>,
    }

    pub trait FastTokenRouterHooksTrait<TContractState> {
        fn fast_transfer_to_hook(
            ref self: ComponentState<TContractState>, recipient: u256, amount: u256
        );
        fn fast_receive_from_hook(
            ref self: ComponentState<TContractState>, sender: ContractAddress, amount: u256
        );
    }

    pub impl MessageRecipientInternalHookImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +TokenRouterHooksTrait<TContractState>,
        +FastTokenRouterHooksTrait<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        impl TokenRouter: TokenRouterComponent::HasComponent<TContractState>,
    > of IMessageRecipientInternalHookTrait<TContractState> {
        fn _handle(
            ref self: RouterComponent::ComponentState<TContractState>,
            origin: u32,
            sender: u256,
            message: Bytes
        ) {
            let recipient = message.recipient();
            let amount = message.amount();
            let metadata = message.metadata();

            let mut contract_state = RouterComponent::HasComponent::get_contract_mut(ref self);
            let mut component_state = HasComponent::get_component_mut(ref contract_state);
            component_state._transfer_to(recipient, amount, origin, metadata);
            let mut component_state = TokenRouterComponent::HasComponent::get_component_mut(
                ref contract_state
            );
            component_state
                .emit(TokenRouterComponent::ReceivedTransferRemote { origin, recipient, amount });
        }
    }

    #[embeddable_as(FastTokenRouterImpl)]
    impl FastTokenRouter<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +TokenRouterHooksTrait<TContractState>,
        impl FTRHooks: FastTokenRouterHooksTrait<TContractState>,
        impl MailBoxClient: MailboxclientComponent::HasComponent<TContractState>,
        impl Router: RouterComponent::HasComponent<TContractState>,
        impl Owner: OwnableComponent::HasComponent<TContractState>,
        impl GasRouter: GasRouterComponent::HasComponent<TContractState>,
        impl TokenRouter: TokenRouterComponent::HasComponent<TContractState>,
    > of super::IFastTokenRouter<ComponentState<TContractState>> {
        /// Fills a fast transfer request by transferring the specified amount minus the fast fee to the recipient.
        ///
        /// This function is used to process a fast transfer request, ensuring that the transfer has not already been filled.
        /// It deducts the fast fee from the total amount and transfers the remaining amount to the recipient. The function also
        /// records the sender's address in the filled fast transfer mapping.
        ///
        /// # Arguments
        ///
        /// * `recipient` - A `u256` representing the recipient of the fast transfer.
        /// * `amount` - A `u256` representing the total amount of the fast transfer.
        /// * `fast_fee` - A `u256` representing the fee to be deducted from the transfer amount.
        /// * `origin` - A `u32` representing the domain of origin for the transfer.
        /// * `fast_transfer_id` - A `u256` representing the unique ID of the fast transfer request.
        ///
        /// # Panics
        ///
        /// Panics if the fast transfer has already been filled.
        fn fill_fast_transfer(
            ref self: ComponentState<TContractState>,
            recipient: u256,
            amount: u256,
            fast_fee: u256,
            origin: u32,
            fast_transfer_id: u256
        ) {
            let filled_fast_transfer_key = self
                ._get_fast_transfers_key(origin, fast_transfer_id, amount, fast_fee, recipient);

            assert!(
                self
                    .filled_fast_transfers
                    .read(filled_fast_transfer_key) == starknet::contract_address_const::<0>(),
                "Fast transfer: request already filled"
            );

            let caller = starknet::get_caller_address();
            self.filled_fast_transfers.write(filled_fast_transfer_key, caller);

            FTRHooks::fast_receive_from_hook(ref self, caller, amount - fast_fee);
            FTRHooks::fast_transfer_to_hook(ref self, recipient, amount - fast_fee);
        }

        /// Initiates a fast transfer to a remote domain and returns the message ID for tracking.
        ///
        /// This function sends a fast transfer to a recipient in a specified remote domain. It deducts the fast fee
        /// from the total amount and dispatches the transfer using the gas router and mailbox components. The function
        /// emits an event for the sent transfer and returns the message ID for tracking the transfer.
        ///
        /// # Arguments
        ///
        /// * `destination` - A `u32` representing the destination domain.
        /// * `recipient` - A `u256` representing the recipient's address.
        /// * `amount_or_id` - A `u256` representing the amount to transfer or the token ID.
        /// * `fast_fee` - A `u256` representing the fast transfer fee.
        /// * `value` - A `u256` representing the value being transferred with the message.
        ///
        /// # Returns
        ///
        /// A `u256` representing the message ID for the dispatched fast transfer.
        fn fast_transfer_remote(
            ref self: ComponentState<TContractState>,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            fast_fee: u256,
            value: u256,
        ) -> u256 {
            let mut gas_router_comp = get_dep_component_mut!(ref self, GasRouter);
            let mut mailbox_comp = get_dep_component_mut!(ref self, MailBoxClient);
            let mut token_router_comp = get_dep_component_mut!(ref self, TokenRouter);

            let fast_transfer_id = self.fast_transfer_id.read() + 1;
            self.fast_transfer_id.write(fast_transfer_id);

            let metadata = self
                ._fast_transfer_from_sender(amount_or_id, fast_fee, fast_transfer_id);

            let message_body = TokenMessageTrait::format(recipient, amount_or_id, metadata);
            let hook = mailbox_comp.get_hook();
            let message_id = gas_router_comp
                ._Gas_router_dispatch(destination, value, message_body, hook);

            token_router_comp
                .emit(
                    TokenRouterComponent::SentTransferRemote {
                        destination, recipient, amount: amount_or_id,
                    }
                );
            message_id
        }
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +TokenRouterHooksTrait<TContractState>,
        impl FTRHooks: FastTokenRouterHooksTrait<TContractState>,
        impl MailBoxClient: MailboxclientComponent::HasComponent<TContractState>,
        impl Router: RouterComponent::HasComponent<TContractState>,
        impl Owner: OwnableComponent::HasComponent<TContractState>,
        impl GasRouter: GasRouterComponent::HasComponent<TContractState>,
        impl TokenRouter: TokenRouterComponent::HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        fn _transfer_to(
            ref self: ComponentState<TContractState>,
            recipient: u256,
            amount: u256,
            origin: u32,
            metadata: Bytes
        ) {
            let token_recipient = self._get_token_recipient(recipient, amount, origin, metadata);

            FTRHooks::fast_transfer_to_hook(ref self, token_recipient, amount);
        }

        fn _get_token_recipient(
            self: @ComponentState<TContractState>,
            recipient: u256,
            amount: u256,
            origin: u32,
            metadata: Bytes
        ) -> u256 {
            if metadata.size() == 0 {
                return recipient;
            }

            let (_, fast_fee) = metadata.read_u256(0);
            let (_, fast_transfer_id) = metadata.read_u256(2);

            let filler_address = self
                ._get_fast_transfers_key(origin, fast_transfer_id, amount, fast_fee, recipient);
            if filler_address == 0 {
                return filler_address;
            }

            recipient
        }

        fn _get_fast_transfers_key(
            self: @ComponentState<TContractState>,
            origin: u32,
            fast_transfer_id: u256,
            amount: u256,
            fast_fee: u256,
            recipient: u256
        ) -> u256 {
            let data = BytesTrait::new(
                9,
                array![
                    origin.into(),
                    fast_transfer_id.low,
                    fast_transfer_id.high,
                    amount.low,
                    amount.high,
                    fast_fee.low,
                    fast_fee.high,
                    recipient.low,
                    recipient.high
                ]
            );
            data.keccak()
        }

        fn _fast_transfer_from_sender(
            ref self: ComponentState<TContractState>,
            amount: u256,
            fast_fee: u256,
            fast_transfer_id: u256
        ) -> Bytes {
            FTRHooks::fast_receive_from_hook(ref self, starknet::get_caller_address(), amount);
            BytesTrait::new(
                4, array![fast_fee.low, fast_fee.high, fast_transfer_id.low, fast_transfer_id.high]
            )
        }
    }
}


pub impl FastTokenRouterHooksEmptyImpl<
    TContractState
> of FastTokenRouterComponent::FastTokenRouterHooksTrait<TContractState> {
    fn fast_transfer_to_hook(
        ref self: FastTokenRouterComponent::ComponentState<TContractState>,
        recipient: u256,
        amount: u256
    ) {}
    fn fast_receive_from_hook(
        ref self: FastTokenRouterComponent::ComponentState<TContractState>,
        sender: starknet::ContractAddress,
        amount: u256
    ) {}
}
