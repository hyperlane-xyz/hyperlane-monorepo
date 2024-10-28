#[starknet::contract]
pub mod noop_ism {
    use alexandria_bytes::Bytes;
    use contracts::interfaces::{
        ModuleType, IInterchainSecurityModule, IInterchainSecurityModuleDispatcher,
        IInterchainSecurityModuleDispatcherTrait
    };
    use contracts::libs::message::Message;
    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl IInterchainSecurityModuleImpl of IInterchainSecurityModule<ContractState> {
        fn module_type(self: @ContractState) -> ModuleType {
            ModuleType::NULL(())
        }

        /// Requires that m-of-n ISMs verify the provided interchain message.
        /// Dev: Can change based on the content of _message
        /// Dev: Reverts if threshold is not set
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded metadata (see aggregation_ism_metadata.cairo)
        /// * - `_message` - message structure containing relevant information (see message.cairo)
        /// 
        /// # Returns 
        /// 
        /// boolean - wheter the verification succeed or not.
        fn verify(self: @ContractState, _metadata: Bytes, _message: Message) -> bool {
            true
        }
    }
}
