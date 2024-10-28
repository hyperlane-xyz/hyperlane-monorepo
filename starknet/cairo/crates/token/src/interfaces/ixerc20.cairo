#[starknet::interface]
pub trait IXERC20<TState> {
    fn mint(ref self: TState, user: starknet::ContractAddress, amount: u256);
    fn burn(ref self: TState, user: starknet::ContractAddress, amount: u256);
    fn set_limits(ref self: TState, bridge: u256, minting_limit: u256, burning_limit: u256);
    fn owner(self: @TState) -> u256;
    fn burning_current_limit_of(self: @TState, bridge: u256) -> u256;
    fn minting_current_limit_of(self: @TState, bridge: u256) -> u256;
    fn minting_max_limit_of(self: @TState, minter: u256) -> u256;
    fn burning_max_limit_of(self: @TState, bridge: u256) -> u256;
}
