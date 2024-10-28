// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts for Cairo ^0.15.0

#[starknet::interface]
pub trait MockEth<TContractState> {
    fn mint(ref self: TContractState, recipient: starknet::ContractAddress, amount: u256);
}

#[starknet::contract]
mod Ether {
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::ERC20Component;
    use openzeppelin::token::erc20::ERC20HooksEmptyImpl;
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    #[abi(embed_v0)]
    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;

    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.erc20.initializer("Ether", "ETH");
        self.ownable.initializer(owner);
    }

    #[abi(embed_v0)]
    impl MockEthImpl of super::MockEth<ContractState> {
        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.ownable.assert_only_owner();
            self.erc20.mint(recipient, amount);
        }
    }
}
