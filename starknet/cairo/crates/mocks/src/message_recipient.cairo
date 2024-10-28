#[starknet::contract]
pub mod message_recipient {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};
    use contracts::interfaces::{
        IMessageRecipient, IMessageRecipientDispatcher, IMessageRecipientDispatcherTrait,
        ModuleType, ISpecifiesInterchainSecurityModule,
        ISpecifiesInterchainSecurityModuleDispatcher,
        ISpecifiesInterchainSecurityModuleDispatcherTrait
    };
    use starknet::ContractAddress;


    #[storage]
    struct Storage {
        origin: u32,
        sender: u256,
        message: Bytes,
        ism: ContractAddress
    }

    #[constructor]
    fn constructor(ref self: ContractState, _ism: ContractAddress) {
        self.ism.write(_ism);
    }

    #[abi(embed_v0)]
    impl IMessageRecipientImpl of IMessageRecipient<ContractState> {
        fn handle(ref self: ContractState, _origin: u32, _sender: u256, _message: Bytes) {
            self.message.write(_message);
            self.origin.write(_origin);
            self.sender.write(_sender);
        }

        fn get_origin(self: @ContractState) -> u32 {
            self.origin.read()
        }

        fn get_sender(self: @ContractState) -> u256 {
            self.sender.read()
        }

        fn get_message(self: @ContractState) -> Bytes {
            self.message.read()
        }
    }

    #[abi(embed_v0)]
    impl ISpecifiesInterchainSecurityModuleImpl of ISpecifiesInterchainSecurityModule<
        ContractState
    > {
        fn interchain_security_module(self: @ContractState) -> ContractAddress {
            self.ism.read()
        }
    }
}
