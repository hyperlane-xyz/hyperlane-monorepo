#[starknet::contract]
pub mod trusted_relayer_ism {
    use alexandria_bytes::Bytes;
    use contracts::interfaces::{
        ModuleType, IInterchainSecurityModule, IInterchainSecurityModuleDispatcher,
        IInterchainSecurityModuleDispatcherTrait, IMailboxDispatcher, IMailboxDispatcherTrait,
    };
    use contracts::libs::message::{Message, MessageTrait};
    use starknet::ContractAddress;

    #[storage]
    struct Storage {
        mailbox: ContractAddress,
        trusted_relayer: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, _mailbox: ContractAddress, _trusted_relayer: ContractAddress
    ) {
        self.mailbox.write(_mailbox);
        self.trusted_relayer.write(_trusted_relayer);
    }
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
            let mailbox = IMailboxDispatcher { contract_address: self.mailbox.read() };
            let (id, _) = MessageTrait::format_message(_message);
            mailbox.processor(id) == self.trusted_relayer.read()
        }
    }
}
