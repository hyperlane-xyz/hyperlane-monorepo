use starknet::ContractAddress;

#[starknet::interface]
pub trait IXERC20Test<TContractState> {
    fn mint(ref self: TContractState, account: ContractAddress, amount: u256);
    fn burn(ref self: TContractState, account: ContractAddress, amount: u256);
    fn set_limits(ref self: TContractState, address: ContractAddress, arg1: u256, arg2: u256);
    fn owner(self: @TContractState) -> ContractAddress;
    fn burning_current_limit_of(self: @TContractState, bridge: ContractAddress) -> u256;
    fn minting_current_limit_of(self: @TContractState, bridge: ContractAddress) -> u256;
    fn minting_max_limit_of(self: @TContractState, bridge: ContractAddress) -> u256;
    fn burning_max_limit_of(self: @TContractState, bridge: ContractAddress) -> u256;
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod XERC20Test {
    use openzeppelin::token::erc20::{ERC20Component, ERC20HooksEmptyImpl};

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
    impl IXERC20TestImpl of super::IXERC20Test<ContractState> {
        fn mint(ref self: ContractState, account: starknet::ContractAddress, amount: u256) {
            self.erc20.mint(account, amount);
        }

        fn burn(ref self: ContractState, account: starknet::ContractAddress, amount: u256) {
            self.erc20.burn(account, amount);
        }

        fn set_limits(
            ref self: ContractState, address: starknet::ContractAddress, arg1: u256, arg2: u256
        ) {
            assert!(false);
        }

        fn owner(self: @ContractState) -> starknet::ContractAddress {
            starknet::contract_address_const::<0x0>()
        }

        fn burning_current_limit_of(
            self: @ContractState, bridge: starknet::ContractAddress
        ) -> u256 {
            core::integer::BoundedInt::<u256>::max()
        }

        fn minting_current_limit_of(
            self: @ContractState, bridge: starknet::ContractAddress
        ) -> u256 {
            core::integer::BoundedInt::<u256>::max()
        }

        fn minting_max_limit_of(self: @ContractState, bridge: starknet::ContractAddress) -> u256 {
            core::integer::BoundedInt::<u256>::max()
        }

        fn burning_max_limit_of(self: @ContractState, bridge: starknet::ContractAddress) -> u256 {
            core::integer::BoundedInt::<u256>::max()
        }
        fn total_supply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }
        fn balance_of(self: @ContractState, account: starknet::ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }
        fn allowance(
            self: @ContractState,
            owner: starknet::ContractAddress,
            spender: starknet::ContractAddress
        ) -> u256 {
            self.erc20.allowance(owner, spender)
        }
        fn transfer(
            ref self: ContractState, recipient: starknet::ContractAddress, amount: u256
        ) -> bool {
            self.erc20.transfer(recipient, amount)
        }
        fn transfer_from(
            ref self: ContractState,
            sender: starknet::ContractAddress,
            recipient: starknet::ContractAddress,
            amount: u256
        ) -> bool {
            self.erc20.transfer_from(sender, recipient, amount)
        }
        fn approve(
            ref self: ContractState, spender: starknet::ContractAddress, amount: u256
        ) -> bool {
            self.erc20.approve(spender, amount)
        }
    }
}
