use starknet::ContractAddress;

pub impl U256TryIntoContractAddress of TryInto<u256, ContractAddress> {
    fn try_into(self: u256) -> Option<ContractAddress> {
        let maybe_value: Option<felt252> = self.try_into();
        match maybe_value {
            Option::Some(value) => value.try_into(),
            Option::None => Option::None,
        }
    }
}
