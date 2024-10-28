use alexandria_bytes::Bytes;
use contracts::libs::message::Message;

#[starknet::interface]
pub trait ITestInterchainGasPayment<TContractState> {
    fn quote_gas_payment(self: @TContractState, gas_amount: u256) -> u256;
    fn get_default_gas_usage(self: @TContractState) -> u256;
    fn gas_price(self: @TContractState) -> u256;
    fn post_dispatch(ref self: TContractState, metadata: Bytes, message: Message);
}

#[starknet::contract]
pub mod TestInterchainGasPayment {
    use alexandria_bytes::Bytes;
    use contracts::libs::message::{Message, MessageTrait};
    use openzeppelin::access::ownable::OwnableComponent;
    use starknet::ContractAddress;

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        gas_price: u256,
        beneficiary: ContractAddress,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        let caller = starknet::get_caller_address();
        self.initialize(caller, caller);
    }

    #[abi(embed_v0)]
    impl TestInterchainGasPaymentImpl of super::ITestInterchainGasPayment<ContractState> {
        fn quote_gas_payment(self: @ContractState, gas_amount: u256) -> u256 {
            self.gas_price.read() * gas_amount
        }

        fn get_default_gas_usage(self: @ContractState) -> u256 {
            50_000
        }

        fn gas_price(self: @ContractState) -> u256 {
            self.gas_price.read()
        }
        fn post_dispatch(ref self: ContractState, metadata: Bytes, message: Message) {}
    }

    #[generate_trait]
    impl Private of PrivateTrait {
        fn initialize(
            ref self: ContractState, owner: ContractAddress, beneficiary: ContractAddress,
        ) {
            self.gas_price.write(10);
            self.beneficiary.write(beneficiary);
            self.ownable.initializer(owner);
        }
    }
}
