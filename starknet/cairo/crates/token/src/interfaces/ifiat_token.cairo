#[starknet::interface]
pub trait IFiatToken<TState> {
    fn burn(ref self: TState, amount: u256);
    fn mint(ref self: TState, to: starknet::ContractAddress, amount: u256) -> bool;
}
