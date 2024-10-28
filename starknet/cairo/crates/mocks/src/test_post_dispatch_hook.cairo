use alexandria_bytes::Bytes;
use contracts::libs::message::{Message, MessageTrait};

#[starknet::interface]
pub trait ITestPostDispatchHook<TContractState> {
    fn hook_type(self: @TContractState) -> u8;
    fn supports_metadata(self: @TContractState, _metadata: Bytes) -> bool;
    fn set_fee(ref self: TContractState, fee: u256);
    fn message_dispatched(self: @TContractState, message_id: u256) -> bool;
    fn post_dispatch(ref self: TContractState, metadata: Bytes, message: Message);
    fn quote_dispatch(ref self: TContractState, metadata: Bytes, message: Message) -> u256;
}

#[starknet::contract]
pub mod TestPostDispatchHook {
    use alexandria_bytes::Bytes;
    use contracts::libs::message::{Message, MessageTrait};
    use core::keccak::keccak_u256s_le_inputs;

    #[storage]
    struct Storage {
        fee: u256,
        message_dispatched: LegacyMap<u256, bool>,
    }

    #[abi(embed_v0)]
    impl TestPostDispatchHookImpl of super::ITestPostDispatchHook<ContractState> {
        fn hook_type(self: @ContractState) -> u8 {
            0
        }

        fn supports_metadata(self: @ContractState, _metadata: Bytes) -> bool {
            true
        }

        fn set_fee(ref self: ContractState, fee: u256) {
            self.fee.write(fee);
        }

        fn message_dispatched(self: @ContractState, message_id: u256) -> bool {
            self.message_dispatched.read(message_id)
        }

        fn post_dispatch(ref self: ContractState, metadata: Bytes, message: Message) {
            let hash = keccak_u256s_le_inputs(
                array![
                    message.nonce.into(),
                    message.origin.into(),
                    message.sender,
                    message.destination.into(),
                    message.recipient
                ]
                    .span()
            );
            self.message_dispatched.write(hash, true);
        }

        fn quote_dispatch(ref self: ContractState, metadata: Bytes, message: Message) -> u256 {
            self.fee.read()
        }
    }
}
