#[starknet::contract]
pub mod fee_hook {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};
    use contracts::interfaces::{
        IPostDispatchHook, IPostDispatchHookDispatcher, IPostDispatchHookDispatcherTrait, Types
    };
    use contracts::libs::message::Message;
    use starknet::ContractAddress;

    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl IPostDispatchHookImpl of IPostDispatchHook<ContractState> {
        fn hook_type(self: @ContractState) -> Types {
            Types::UNUSED(())
        }

        fn supports_metadata(self: @ContractState, _metadata: Bytes) -> bool {
            true
        }

        fn post_dispatch(
            ref self: ContractState, _metadata: Bytes, _message: Message, _fee_amount: u256,
        ) {}

        fn quote_dispatch(ref self: ContractState, _metadata: Bytes, _message: Message) -> u256 {
            3000000
        }
    }
}
