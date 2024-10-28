#[starknet::interface]
pub trait IXERC20Lockbox<TState> {
    fn xerc20(self: @TState) -> starknet::ContractAddress;
    fn erc20(self: @TState) -> starknet::ContractAddress;
    fn deposit(ref self: TState, amount: u256);
    fn deposit_to(ref self: TState, user: u256, amount: u256);
    fn deposit_native_to(ref self: TState, user: u256);
    fn withdraw(ref self: TState, amount: u256);
    fn withdraw_to(ref self: TState, user: u256, amount: u256);
}
