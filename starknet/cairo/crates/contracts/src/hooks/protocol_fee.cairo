#[starknet::contract]
pub mod protocol_fee {
    use alexandria_bytes::{Bytes, BytesTrait};
    use contracts::hooks::libs::standard_hook_metadata::standard_hook_metadata::{
        StandardHookMetadata, VARIANT,
    };
    use contracts::interfaces::{IPostDispatchHook, Types, IProtocolFee, ETH_ADDRESS};
    use contracts::libs::message::Message;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::token::erc20::interface::{
        ERC20ABI, ERC20ABIDispatcher, ERC20ABIDispatcherTrait
    };
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{ContractAddress, contract_address_const, get_contract_address};
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        max_protocol_fee: u256,
        protocol_fee: u256,
        beneficiary: ContractAddress,
        fee_token: ContractAddress,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
    }

    mod Errors {
        pub const INVALID_METADATA_VARIANT: felt252 = 'Invalid metadata variant';
        pub const INVALID_BENEFICARY: felt252 = 'Invalid beneficiary';
        pub const EXCEEDS_MAX_PROTOCOL_FEE: felt252 = 'Exceeds max protocol fee';
        pub const INSUFFICIENT_BALANCE: felt252 = 'Insufficient balance';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'Insufficient allowance';
        pub const INSUFFICIENT_PROTOCOL_FEE: felt252 = 'Insufficient protocol fee';
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
    }

    /// Constructor of the contract
    /// 
    /// # Arguments
    ///
    /// * `_max_protocol_fee` - The maximum protocol fee that can be set.
    /// * `_protocol_fee` - The current protocol fee.s
    /// * `_beneficiary` -The beneficiary of protocol fees.
    /// * `_owner` - The owner of the contract
    /// * `_token_address` - The token used as fee
    #[constructor]
    fn constructor(
        ref self: ContractState,
        _max_protocol_fee: u256,
        _protocol_fee: u256,
        _beneficiary: ContractAddress,
        _owner: ContractAddress,
        _token_address: ContractAddress
    ) {
        self.max_protocol_fee.write(_max_protocol_fee);
        self._set_protocol_fee(_protocol_fee);
        self._set_beneficiary(_beneficiary);
        self.ownable.initializer(_owner);
        self.fee_token.write(_token_address);
    }

    #[abi(embed_v0)]
    impl IPostDispatchHookImpl of IPostDispatchHook<ContractState> {
        fn hook_type(self: @ContractState) -> Types {
            Types::PROTOCOL_FEE(())
        }
        /// Returns whether the hook supports metadata
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - metadata
        /// 
        /// # Returns
        /// 
        /// boolean - whether the hook supports metadata
        fn supports_metadata(self: @ContractState, _metadata: Bytes) -> bool {
            _metadata.size() == 0 || StandardHookMetadata::variant(_metadata) == VARIANT.into()
        }

        /// Post action after a message is dispatched via the Mailbox
        /// Dev: reverts if invalid metadata variant
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - the metadata required for the hook
        /// * - `_message` - the message passed from the Mailbox.dispatch() call
        /// * - `_fee_amount` - the payment provided for sending the message
        fn post_dispatch(
            ref self: ContractState, _metadata: Bytes, _message: Message, _fee_amount: u256
        ) {
            assert(self.supports_metadata(_metadata.clone()), Errors::INVALID_METADATA_VARIANT);
            self._post_dispatch(_metadata, _message, _fee_amount);
        }

        ///  Computes the payment required by the postDispatch call
        /// Dev: reverts if invalid metadata variant
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - The metadata required for the hook
        /// * - `_message` - the message passed from the Mailbox.dispatch() call
        /// 
        /// # Returns 
        /// 
        /// u256 - Quoted payment for the postDispatch call
        fn quote_dispatch(ref self: ContractState, _metadata: Bytes, _message: Message) -> u256 {
            assert(self.supports_metadata(_metadata.clone()), Errors::INVALID_METADATA_VARIANT);
            self._quote_dispatch(_metadata, _message)
        }
    }

    #[abi(embed_v0)]
    pub impl IProtocolFeeImpl of IProtocolFee<ContractState> {
        fn get_protocol_fee(self: @ContractState) -> u256 {
            self.protocol_fee.read()
        }

        /// Sets the protocol fee.
        /// 
        /// # Arguments
        /// 
        /// * - `_protocol_fee` - The new protocol fee.
        fn set_protocol_fee(ref self: ContractState, _protocol_fee: u256) {
            self.ownable.assert_only_owner();
            self._set_protocol_fee(_protocol_fee);
        }

        fn get_beneficiary(self: @ContractState) -> ContractAddress {
            self.beneficiary.read()
        }

        ///  Sets the beneficiary of protocol fees.
        /// 
        /// # Arguments
        /// 
        /// * - `_beneficiary` - The new beneficiary.
        fn set_beneficiary(ref self: ContractState, _beneficiary: ContractAddress) {
            self.ownable.assert_only_owner();
            self._set_beneficiary(_beneficiary);
        }

        /// Collects protocol fees from the contract.
        /// Fees are sent to the beneficary address
        fn collect_protocol_fees(ref self: ContractState) {
            let token_dispatcher = ERC20ABIDispatcher { contract_address: self.fee_token.read() };
            let contract_address = get_contract_address();
            let balance = token_dispatcher.balanceOf(contract_address);
            assert(balance != 0, Errors::INSUFFICIENT_BALANCE);
            token_dispatcher.transfer(self.beneficiary.read(), balance);
        }
    }


    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Post action after a message is dispatched via the Mailbox (in our case, nothing because the )
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - the metadata required for the hook
        /// * - `_message` - the message passed from the Mailbox.dispatch() call
        /// * - `_fee_amount` - the payment provided for sending the message
        fn _post_dispatch(
            ref self: ContractState, _metadata: Bytes, _message: Message, _fee_amount: u256
        ) { // Since payment is exact, no need for further operation
        }

        ///  Returns the static protocol fee 
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - The metadata required for the hook
        /// * - `_message` - the message passed from the Mailbox.dispatch() call
        /// 
        /// # Returns 
        /// 
        /// u256 - Quoted payment for the postDispatch call
        fn _quote_dispatch(ref self: ContractState, _metadata: Bytes, _message: Message) -> u256 {
            self.protocol_fee.read()
        }

        ///  Sets the protocol fee.
        /// Dev: reverts if protocol exceeds max protocol fee
        /// 
        /// # Arguments
        /// 
        /// * - `_protocol_fee` - The new protocol fee.
        fn _set_protocol_fee(ref self: ContractState, _protocol_fee: u256) {
            assert(_protocol_fee <= self.max_protocol_fee.read(), Errors::EXCEEDS_MAX_PROTOCOL_FEE);
            self.protocol_fee.write(_protocol_fee);
        }

        /// Sets the beneficiary of protocol fees.
        /// Dev: reverts if beneficiary is null address
        /// 
        /// # Arguments
        /// 
        /// * - `_beneficiary` - The new beneficiary.
        fn _set_beneficiary(ref self: ContractState, _beneficiary: ContractAddress) {
            assert(_beneficiary != contract_address_const::<0>(), Errors::INVALID_BENEFICARY);
            self.beneficiary.write(_beneficiary);
        }
    }
}
