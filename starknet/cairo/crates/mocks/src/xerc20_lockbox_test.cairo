#[starknet::interface]
pub trait IXERC20LockboxTest<TContractState> {
    fn xerc20(self: @TContractState) -> starknet::ContractAddress;
    fn erc20(self: @TContractState) -> starknet::ContractAddress;
    fn deposit_to(ref self: TContractState, user: starknet::ContractAddress, amount: u256);
    fn deposit(ref self: TContractState, amount: u256);
    fn withdraw_to(ref self: TContractState, user: u256, amount: u256);
    fn withdraw(ref self: TContractState, amount: u256);
}

#[starknet::contract]
pub mod XERC20LockboxTest {
    use mocks::{
        test_erc20::{ITestERC20Dispatcher, ITestERC20DispatcherTrait},
        xerc20_test::{IXERC20TestDispatcher, IXERC20TestDispatcherTrait}
    };
    use starknet::ContractAddress;

    #[storage]
    struct Storage {
        XERC20: ContractAddress,
        ERC20: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, xerc20: ContractAddress, erc20: ContractAddress) {
        self.XERC20.write(xerc20);
        self.ERC20.write(erc20);
    }

    #[abi(embed_v0)]
    impl IXERC20LockboxTest of super::IXERC20LockboxTest<ContractState> {
        fn xerc20(self: @ContractState) -> ContractAddress {
            self.XERC20.read()
        }

        fn erc20(self: @ContractState) -> ContractAddress {
            self.ERC20.read()
        }

        fn deposit_to(ref self: ContractState, user: starknet::ContractAddress, amount: u256) {
            let erc20 = ITestERC20Dispatcher { contract_address: self.ERC20.read() };
            erc20
                .transfer_from(
                    starknet::get_caller_address(), starknet::get_contract_address(), amount
                );
            let xerc20 = IXERC20TestDispatcher { contract_address: self.XERC20.read() };
            xerc20.mint(user, amount);
        }
        fn deposit(ref self: ContractState, amount: u256) {
            self.deposit_to(starknet::get_caller_address(), amount);
        }

        fn withdraw_to(ref self: ContractState, user: u256, amount: u256) {
            let xerc20 = IXERC20TestDispatcher { contract_address: self.XERC20.read() };
            xerc20.burn(starknet::get_caller_address(), amount);
            let erc20 = ITestERC20Dispatcher { contract_address: self.ERC20.read() };
            let user_address: felt252 = user.try_into().unwrap();
            erc20.mint_to(user_address.try_into().unwrap(), amount);
        }

        fn withdraw(ref self: ContractState, amount: u256) {
            let caller_address: felt252 = starknet::get_caller_address().into();
            self.withdraw_to(caller_address.into(), amount);
        }
    }
}
