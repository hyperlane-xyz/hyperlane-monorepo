//! ERC4626 Interface 
//! For details see {https://eips.ethereum.org/EIPS/eip-4626}
//! Modified from {https://github.com/0xHashstack/hashstack_contracts/blob/main/src/token/erc4626/IERC4626.cairo}
use starknet::ContractAddress;

#[starknet::interface]
pub trait IERC4626<TState> {
    // ************************************
    // * IERC20
    // ************************************
    fn total_supply(self: @TState) -> u256;
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn allowance(self: @TState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    // ************************************
    // * IERC20 metadata
    // ************************************
    fn name(self: @TState) -> ByteArray;
    fn symbol(self: @TState) -> ByteArray;
    fn decimals(self: @TState) -> u8;
    // ************************************
    // * IERC4626
    // ************************************
    fn asset(self: @TState) -> ContractAddress;
    fn convert_to_assets(self: @TState, shares: u256) -> u256;
    fn convert_to_shares(self: @TState, assets: u256) -> u256;
    fn deposit(ref self: TState, assets: u256, receiver: ContractAddress) -> u256;
    fn mint(ref self: TState, shares: u256, receiver: ContractAddress) -> u256;
    fn preview_deposit(self: @TState, assets: u256) -> u256;
    fn preview_mint(self: @TState, shares: u256) -> u256;
    fn preview_redeem(self: @TState, shares: u256) -> u256;
    fn preview_withdraw(self: @TState, assets: u256) -> u256;
    fn redeem(
        ref self: TState, shares: u256, receiver: ContractAddress, owner: ContractAddress
    ) -> u256;
    fn total_assets(self: @TState) -> u256;
    fn withdraw(
        ref self: TState, assets: u256, receiver: ContractAddress, owner: ContractAddress
    ) -> u256;
    fn max_deposit(self: @TState, receiver: ContractAddress) -> u256;
    fn max_mint(self: @TState, receiver: ContractAddress) -> u256;
    fn max_withdraw(self: @TState, owner: ContractAddress) -> u256;
    fn max_redeem(self: @TState, owner: ContractAddress) -> u256;
}

#[starknet::interface]
pub trait IERC4626Metadata<TState> {
    fn name(self: @TState) -> ByteArray;
    fn symbol(self: @TState) -> ByteArray;
    fn decimals(self: @TState) -> u8;
}

#[starknet::interface]
pub trait IERC4626Camel<TState> {
    fn totalSupply(self: @TState) -> u256;
    fn totalAssets(self: @TState) -> u256;
    fn balanceOf(self: @TState, account: ContractAddress) -> u256;
    fn transferFrom(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn previewDeposit(self: @TState, assets: u256) -> u256;
    fn previewMint(self: @TState, shares: u256) -> u256;
    fn previewRedeem(self: @TState, shares: u256) -> u256;
    fn previewWithdraw(self: @TState, assets: u256) -> u256;
    fn convertToAssets(self: @TState, shares: u256) -> u256;
    fn convertToShares(self: @TState, assets: u256) -> u256;
    fn maxDeposit(self: @TState, receiver: ContractAddress) -> u256;
    fn maxMint(self: @TState, receiver: ContractAddress) -> u256;
    fn maxWithdraw(self: @TState, owner: ContractAddress) -> u256;
    fn maxRedeem(self: @TState, owner: ContractAddress) -> u256;
}

#[starknet::interface]
pub trait ERC4626ABI<TState> {
    // ************************************
    // * IERC4626 Metadata
    // ************************************
    fn name(self: @TState) -> ByteArray;
    fn symbol(self: @TState) -> ByteArray;
    fn decimals(self: @TState) -> u8;
    // ************************************
    // * IERC4626 Snake Case
    // ************************************
    fn asset(self: @TState) -> ContractAddress;
    fn convert_to_assets(self: @TState, shares: u256) -> u256;
    fn convert_to_shares(self: @TState, assets: u256) -> u256;
    fn deposit(ref self: TState, assets: u256, receiver: ContractAddress) -> u256;
    fn mint(ref self: TState, shares: u256, receiver: ContractAddress) -> u256;
    fn preview_deposit(self: @TState, assets: u256) -> u256;
    fn preview_mint(self: @TState, shares: u256) -> u256;
    fn preview_redeem(self: @TState, shares: u256) -> u256;
    fn preview_withdraw(self: @TState, assets: u256) -> u256;
    fn redeem(
        ref self: TState, shares: u256, receiver: ContractAddress, owner: ContractAddress
    ) -> u256;
    fn total_supply(self: @TState) -> u256;
    fn total_assets(self: @TState) -> u256;
    fn withdraw(
        ref self: TState, assets: u256, receiver: ContractAddress, owner: ContractAddress
    ) -> u256;
    fn max_deposit(self: @TState, receiver: ContractAddress) -> u256;
    fn max_mint(self: @TState, receiver: ContractAddress) -> u256;
    fn max_withdraw(self: @TState, owner: ContractAddress) -> u256;
    fn max_redeem(self: @TState, owner: ContractAddress) -> u256;
    // ************************************
    // * IERC4626 Camel Case
    // ************************************
    fn totalSupply(self: @TState) -> u256;
    fn totalAssets(self: @TState) -> u256;
    fn balanceOf(self: @TState, account: ContractAddress) -> u256;
    fn transferFrom(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn previewDeposit(self: @TState, assets: u256) -> u256;
    fn previewMint(self: @TState, shares: u256) -> u256;
    fn previewRedeem(self: @TState, shares: u256) -> u256;
    fn previewWithdraw(self: @TState, assets: u256) -> u256;
    fn convertToAssets(self: @TState, shares: u256) -> u256;
    fn convertToShares(self: @TState, assets: u256) -> u256;
    fn maxDeposit(self: @TState, receiver: ContractAddress) -> u256;
    fn maxMint(self: @TState, receiver: ContractAddress) -> u256;
    fn maxWithdraw(self: @TState, owner: ContractAddress) -> u256;
    fn maxRedeem(self: @TState, owner: ContractAddress) -> u256;
}
