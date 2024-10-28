use alexandria_bytes::{Bytes, BytesTrait};
use contracts::client::gas_router_component::{
    GasRouterComponent, GasRouterComponent::InternalTrait as GasRouterComponentInternalTrait
};
use contracts::client::mailboxclient_component::MailboxclientComponent;
use contracts::client::router_component::{
    RouterComponent, RouterComponent::InternalTrait as RouterComponentInternalTrait
};
use contracts::interfaces::IMailboxClient;
use openzeppelin::access::ownable::OwnableComponent;
use starknet::ContractAddress;
use token::components::token_message::TokenMessageTrait;

#[starknet::interface]
pub trait ITokenRouter<TState> {
    fn transfer_remote(
        ref self: TState,
        destination: u32,
        recipient: u256,
        amount_or_id: u256,
        value: u256,
        hook_metadata: Option<Bytes>,
        hook: Option<ContractAddress>
    ) -> u256;
}

#[starknet::component]
pub mod TokenRouterComponent {
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
        RouterComponent::IMessageRecipientInternalHookTrait,
    };
    use openzeppelin::access::ownable::{
        OwnableComponent, OwnableComponent::InternalImpl as OwnableInternalImpl
    };
    use starknet::ContractAddress;
    use token::components::token_message::TokenMessageTrait;

    #[storage]
    struct Storage {}

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SentTransferRemote: SentTransferRemote,
        ReceivedTransferRemote: ReceivedTransferRemote,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SentTransferRemote {
        #[key]
        pub destination: u32,
        #[key]
        pub recipient: u256,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ReceivedTransferRemote {
        #[key]
        pub origin: u32,
        #[key]
        pub recipient: u256,
        pub amount: u256,
    }

    pub trait TokenRouterHooksTrait<TContractState> {
        fn transfer_from_sender_hook(
            ref self: ComponentState<TContractState>, amount_or_id: u256
        ) -> Bytes;

        fn transfer_to_hook(
            ref self: ComponentState<TContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        );
    }

    pub trait TokenRouterTransferRemoteHookTrait<TContractState> {
        fn _transfer_remote(
            ref self: ComponentState<TContractState>,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            value: u256,
            hook_metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256;
    }

    pub impl MessageRecipientInternalHookImpl<
        TContractState,
        +HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        impl Hooks: TokenRouterHooksTrait<TContractState>,
        +Drop<TContractState>,
    > of IMessageRecipientInternalHookTrait<TContractState> {
        /// Handles the receipt of a message and processes a token transfer.
        ///
        /// This function is invoked when a message is received, processing the transfer of tokens to the recipient.
        /// It retrieves the recipient, amount, and metadata from the message and triggers the appropriate hook to
        /// handle the transfer. The function also emits a `ReceivedTransferRemote` event after processing the transfer.
        ///
        /// # Arguments
        ///
        /// * `origin` - A `u32` representing the origin domain.
        /// * `sender` - A `u256` representing the sender's address.
        /// * `message` - A `Bytes` object representing the incoming message.
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
            Hooks::transfer_to_hook(ref component_state, recipient, amount, metadata);
            component_state.emit(ReceivedTransferRemote { origin, recipient, amount });
        }
    }

    #[embeddable_as(TokenRouterImpl)]
    pub impl TokenRouter<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +MailboxclientComponent::HasComponent<TContractState>,
        +RouterComponent::HasComponent<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        +GasRouterComponent::HasComponent<TContractState>,
        +TokenRouterHooksTrait<TContractState>,
        impl TransferRemoteHook: TokenRouterTransferRemoteHookTrait<TContractState>
    > of super::ITokenRouter<ComponentState<TContractState>> {
        /// Initiates a token transfer to a remote domain.
        ///
        /// This function dispatches a token transfer to the specified recipient on a remote domain, transferring
        /// either an amount of tokens or a token ID. It supports optional hooks and metadata for additional
        /// processing during the transfer. The function emits a `SentTransferRemote` event once the transfer is initiated.
        ///
        /// # Arguments
        ///
        /// * `destination` - A `u32` representing the destination domain.
        /// * `recipient` - A `u256` representing the recipient's address.
        /// * `amount_or_id` - A `u256` representing the amount of tokens or token ID to transfer.
        /// * `value` - A `u256` representing the value of the transfer.
        /// * `hook_metadata` - An optional `Bytes` object representing metadata for the hook.
        /// * `hook` - An optional `ContractAddress` representing the contract hook to invoke during the transfer.
        ///
        /// # Returns
        ///
        /// A `u256` representing the message ID of the dispatched transfer.
        fn transfer_remote(
            ref self: ComponentState<TContractState>,
            destination: u32,
            recipient: u256,
            amount_or_id: u256,
            value: u256,
            hook_metadata: Option<Bytes>,
            hook: Option<ContractAddress>
        ) -> u256 {
            match hook_metadata {
                Option::Some(hook_metadata) => {
                    TransferRemoteHook::_transfer_remote(
                        ref self,
                        destination,
                        recipient,
                        amount_or_id,
                        value,
                        Option::Some(hook_metadata),
                        hook
                    )
                },
                Option::None => {
                    TransferRemoteHook::_transfer_remote(
                        ref self,
                        destination,
                        recipient,
                        amount_or_id,
                        value,
                        Option::None,
                        Option::None
                    )
                }
            }
        }
    }

    #[generate_trait]
    pub impl TokenRouterInternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +Drop<TContractState>,
        +OwnableComponent::HasComponent<TContractState>,
        impl MailBoxClient: MailboxclientComponent::HasComponent<TContractState>,
        impl Router: RouterComponent::HasComponent<TContractState>,
        impl GasRouter: GasRouterComponent::HasComponent<TContractState>,
        impl Hooks: TokenRouterHooksTrait<TContractState>
    > of InternalTrait<TContractState> {
        fn _transfer_from_sender(
            ref self: ComponentState<TContractState>, amount_or_id: u256
        ) -> Bytes {
            Hooks::transfer_from_sender_hook(ref self, amount_or_id)
        }

        fn _transfer_to(
            ref self: ComponentState<TContractState>,
            recipient: u256,
            amount_or_id: u256,
            metadata: Bytes
        ) {
            Hooks::transfer_to_hook(ref self, recipient, amount_or_id, metadata);
        }
    }
}

//pub impl TokenRouterEmptyHooksImpl<
//    TContractState
//> of TokenRouterComponent::TokenRouterHooksTrait<TContractState> {
//    fn transfer_from_sender_hook(
//        ref self: TokenRouterComponent::ComponentState<TContractState>, amount_or_id: u256
//    ) -> Bytes {
//        alexandria_bytes::BytesTrait::new_empty()
//    }
//
//    fn transfer_to_hook(
//        ref self: TokenRouterComponent::ComponentState<TContractState>,
//        recipient: u256,
//        amount_or_id: u256,
//        metadata: Bytes
//    ) {}
//}

pub impl TokenRouterTransferRemoteHookDefaultImpl<
    TContractState,
    +Drop<TContractState>,
    +TokenRouterComponent::HasComponent<TContractState>,
    +MailboxclientComponent::HasComponent<TContractState>,
    +RouterComponent::HasComponent<TContractState>,
    +GasRouterComponent::HasComponent<TContractState>,
    +OwnableComponent::HasComponent<TContractState>,
    +TokenRouterComponent::TokenRouterHooksTrait<TContractState>
> of TokenRouterComponent::TokenRouterTransferRemoteHookTrait<TContractState> {
    fn _transfer_remote(
        ref self: TokenRouterComponent::ComponentState<TContractState>,
        destination: u32,
        recipient: u256,
        amount_or_id: u256,
        value: u256,
        hook_metadata: Option<Bytes>,
        hook: Option<ContractAddress>
    ) -> u256 {
        let token_metadata = TokenRouterComponent::TokenRouterInternalImpl::_transfer_from_sender(
            ref self, amount_or_id
        );
        let token_message = TokenMessageTrait::format(recipient, amount_or_id, token_metadata);
        let contract_state = TokenRouterComponent::HasComponent::get_contract(@self);
        let mut router_comp = RouterComponent::HasComponent::get_component(contract_state);
        let mailbox_comp = MailboxclientComponent::HasComponent::get_component(contract_state);
        let gas_router_comp = GasRouterComponent::HasComponent::get_component(contract_state);

        let mut message_id = 0;

        match hook_metadata {
            Option::Some(hook_metadata) => {
                if !hook.is_some() {
                    panic!("Transfer remote invalid arguments, missing hook");
                }

                message_id = router_comp
                    ._Router_dispatch(
                        destination, value, token_message, hook_metadata, hook.unwrap()
                    );
            },
            Option::None => {
                let hook_metadata = gas_router_comp._Gas_router_hook_metadata(destination);
                let hook = mailbox_comp.get_hook();
                message_id = router_comp
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
