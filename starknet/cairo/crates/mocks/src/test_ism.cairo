use alexandria_bytes::Bytes;
use contracts::libs::message::Message;
#[starknet::interface]
pub trait ITestISM<TContractState> {
    fn set_verify(ref self: TContractState, verify: bool);
    fn verify(self: @TContractState, _metadata: Bytes, _message: Message) -> bool;
}

#[starknet::contract]
pub mod TestISM {
    use alexandria_bytes::Bytes;
    use super::ITestISMDispatcher;

    #[storage]
    struct Storage {
        verify_result: bool,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.verify_result.write(true);
    }

    #[abi(embed_v0)]
    impl TestISMImpl of super::ITestISM<ContractState> {
        fn set_verify(ref self: ContractState, verify: bool) {
            self.verify_result.write(verify);
        }

        fn verify(self: @ContractState, _metadata: Bytes, _message: super::Message) -> bool {
            self.verify_result.read()
        }
    }
}
