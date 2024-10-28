#[starknet::contract]
pub mod ism {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};
    use contracts::interfaces::{
        IInterchainSecurityModule, IInterchainSecurityModuleDispatcher,
        IInterchainSecurityModuleDispatcherTrait, ModuleType
    };
    use contracts::libs::message::{Message, MessageTrait};
    use starknet::ContractAddress;
    use starknet::EthAddress;

    #[storage]
    struct Storage {}
    #[abi(embed_v0)]
    impl IMessageidMultisigIsmImpl of IInterchainSecurityModule<ContractState> {
        fn module_type(self: @ContractState) -> ModuleType {
            ModuleType::MESSAGE_ID_MULTISIG(starknet::get_contract_address())
        }

        fn verify(self: @ContractState, _metadata: Bytes, _message: Message,) -> bool {
            true
        }
    }
}
