use starknet::ContractAddress;

#[starknet::interface]
pub trait ITestERC20<TContractState> {
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    fn decimals(self: @TContractState) -> u8;
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256) -> bool;
    fn mint_to(ref self: TContractState, to: ContractAddress, amount: u256);
    fn burn_from(ref self: TContractState, from: ContractAddress, amount: u256);
    fn burn(ref self: TContractState, amount: u256);
}

#[starknet::contract]
pub mod TestERC20 {
    use openzeppelin::token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        decimals: u8,
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, total_supply: u256, decimals: u8) {
        self.decimals.write(decimals);
        self.erc20.mint(starknet::get_caller_address(), total_supply);
    }

    #[abi(embed_v0)]
    impl ITestERC20 of super::ITestERC20<ContractState> {
        fn total_supply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }
        fn decimals(self: @ContractState) -> u8 {
            self.decimals.read()
        }
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) -> bool {
            self.erc20.mint(to, amount);
            true
        }
        fn mint_to(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
        fn burn_from(ref self: ContractState, from: ContractAddress, amount: u256) {
            self.erc20.burn(from, amount);
        }
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.erc20.approve(spender, amount)
        }
        fn burn(ref self: ContractState, amount: u256) {
            self.erc20.burn(starknet::get_caller_address(), amount);
        }
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            self.erc20.transfer(recipient, amount)
        }
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }
        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        ) -> bool {
            self.erc20.transfer_from(sender, recipient, amount)
        }
        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress
        ) -> u256 {
            self.erc20.allowance(owner, spender)
        }
    }
}

