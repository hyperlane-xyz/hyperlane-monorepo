#[starknet::interface]
pub trait IEnumerableMapHolder<TContractState> {
    fn do_get_len(self: @TContractState) -> u32;
    fn do_set_key(ref self: TContractState, key: u32, value: u256);
    fn do_get_value(self: @TContractState, key: u32) -> u256;
    fn do_contains(self: @TContractState, key: u32) -> bool;
    fn do_remove(ref self: TContractState, key: u32) -> bool;
    fn do_at(self: @TContractState, index: u32) -> (u32, u256);
    fn do_get_keys(self: @TContractState) -> Array<u32>;
}

#[starknet::contract]
pub mod EnumerableMapHolder {
    use contracts::libs::enumerable_map::{EnumerableMap, EnumerableMapTrait};

    #[storage]
    struct Storage {
        routers: EnumerableMap<u32, u256>
    }

    #[abi(embed_v0)]
    impl Holder of super::IEnumerableMapHolder<ContractState> {
        fn do_get_len(self: @ContractState) -> u32 {
            let routers = self.routers.read();
            routers.len()
        }
        fn do_set_key(ref self: ContractState, key: u32, value: u256) {
            let mut routers = self.routers.read();
            routers.set(key, value);
        }
        fn do_get_value(self: @ContractState, key: u32) -> u256 {
            let routers = self.routers.read();
            routers.get(key)
        }
        fn do_contains(self: @ContractState, key: u32) -> bool {
            let routers = self.routers.read();
            routers.contains(key)
        }
        fn do_remove(ref self: ContractState, key: u32) -> bool {
            let mut routers = self.routers.read();
            routers.remove(key)
        }
        fn do_at(self: @ContractState, index: u32) -> (u32, u256) {
            let routers = self.routers.read();
            routers.at(index)
        }
        fn do_get_keys(self: @ContractState) -> Array<u32> {
            let routers = self.routers.read();
            routers.keys()
        }
    }
}
