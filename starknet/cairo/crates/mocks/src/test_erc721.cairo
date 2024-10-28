// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts for Cairo ^0.15.0
use starknet::ContractAddress;

#[starknet::interface]
pub trait ITestERC721<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn owner_of(self: @TState, token_id: u256) -> ContractAddress;
    fn safe_transfer_from(
        ref self: TState,
        from: ContractAddress,
        to: ContractAddress,
        token_id: u256,
        data: Span<felt252>
    );
    fn transfer_from(ref self: TState, from: ContractAddress, to: ContractAddress, token_id: u256);
    fn approve(ref self: TState, to: ContractAddress, token_id: u256);
    fn set_approval_for_all(ref self: TState, operator: ContractAddress, approved: bool);
    fn get_approved(self: @TState, token_id: u256) -> ContractAddress;
    fn is_approved_for_all(
        self: @TState, owner: ContractAddress, operator: ContractAddress
    ) -> bool;
    fn token_uri(self: @TState, token_id: u256) -> ByteArray;
}

#[starknet::contract]
mod TestERC721 {
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc721::ERC721Component;
    use openzeppelin::token::erc721::ERC721HooksEmptyImpl;
    use starknet::ContractAddress;

    component!(path: ERC721Component, storage: erc721, event: ERC721Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    impl ERC721Impl = ERC721Component::ERC721Impl<ContractState>;
    impl ERC721MetadataImpl = ERC721Component::ERC721MetadataImpl<ContractState>;
    impl ERC721InternalImpl = ERC721Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc721: ERC721Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC721Event: ERC721Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, mint_amount: u256) {
        self.erc721.initializer("Hyperlane Hedgehogs", "HHH", "http://bit.ly/3reJLpx");
        let mut i: u256 = 0;
        while i < mint_amount {
            self.erc721.mint(starknet::get_caller_address(), i);
            i += 1;
        }
    }

    #[abi(embed_v0)]
    impl TestERC721Impl of super::ITestERC721<ContractState> {
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc721.balance_of(account)
        }

        fn owner_of(self: @ContractState, token_id: u256) -> ContractAddress {
            self.erc721.owner_of(token_id)
        }

        fn safe_transfer_from(
            ref self: ContractState,
            from: ContractAddress,
            to: ContractAddress,
            token_id: u256,
            data: Span<felt252>
        ) {
            self.erc721.safe_transfer_from(from, to, token_id, data)
        }

        fn transfer_from(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, token_id: u256
        ) {
            self.erc721.transfer_from(from, to, token_id)
        }

        fn approve(ref self: ContractState, to: ContractAddress, token_id: u256) {
            self.erc721.approve(to, token_id)
        }

        fn set_approval_for_all(
            ref self: ContractState, operator: ContractAddress, approved: bool
        ) {
            self.erc721.set_approval_for_all(operator, approved)
        }

        fn get_approved(self: @ContractState, token_id: u256) -> ContractAddress {
            self.erc721.get_approved(token_id)
        }

        fn is_approved_for_all(
            self: @ContractState, owner: ContractAddress, operator: ContractAddress
        ) -> bool {
            self.erc721.is_approved_for_all(owner, operator)
        }

        fn token_uri(self: @ContractState, token_id: u256) -> ByteArray {
            self.erc721.token_uri(token_id)
        }
    }
}
