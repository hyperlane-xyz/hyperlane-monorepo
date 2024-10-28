#[starknet::contract]
pub mod validator_announce {
    use alexandria_bytes::{Bytes, BytesTrait};
    use alexandria_data_structures::array_ext::ArrayTraitExt;
    use contracts::client::mailboxclient_component::{
        MailboxclientComponent, MailboxclientComponent::MailboxClientInternalImpl,
        MailboxclientComponent::MailboxClientImpl
    };
    use contracts::interfaces::{
        IMailboxClientDispatcher, IMailboxClientDispatcherTrait, IValidatorAnnounce
    };
    use contracts::libs::checkpoint_lib::checkpoint_lib::HYPERLANE_ANNOUNCEMENT;
    use contracts::utils::keccak256::{
        reverse_endianness, to_eth_signature, compute_keccak, ByteData, u256_word_size,
        u64_word_size, HASH_SIZE, bool_is_eth_signature_valid
    };
    use contracts::utils::store_arrays::StoreFelt252Array;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::upgrades::{interface::IUpgradeable, upgradeable::UpgradeableComponent};
    use starknet::{
        ContractAddress, ClassHash, EthAddress, secp256_trait::{Signature, signature_from_vrs}
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    component!(path: MailboxclientComponent, storage: mailboxclient, event: MailboxclientEvent);

    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        mailboxclient: MailboxclientComponent::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        storage_location_len: LegacyMap::<EthAddress, u256>,
        storage_locations: LegacyMap::<(EthAddress, u256), Array<felt252>>,
        replay_protection: LegacyMap::<felt252, bool>,
        validators: LegacyMap::<EthAddress, EthAddress>,
    }


    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ValidatorAnnouncement: ValidatorAnnouncement,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        #[flat]
        MailboxclientEvent: MailboxclientComponent::Event,
    }

    #[derive(starknet::Event, Drop)]
    pub struct ValidatorAnnouncement {
        pub validator: EthAddress,
        pub storage_location: Span<felt252>
    }

    pub mod Errors {
        pub const REPLAY_PROTECTION_ERROR: felt252 = 'Announce already occured';
        pub const WRONG_SIGNER: felt252 = 'Wrong signer';
    }

    #[constructor]
    fn constructor(ref self: ContractState, _mailbox: ContractAddress, _owner: ContractAddress) {
        self.mailboxclient.initialize(_mailbox, Option::None, Option::None);
        self.ownable.initializer(_owner);
    }


    #[abi(embed_v0)]
    impl Upgradeable of IUpgradeable<ContractState> {
        /// Upgrades the contract to a new implementation.
        /// Callable only by the owner
        /// 
        /// # Arguments
        ///
        /// * `new_class_hash` - The class hash of the new implementation.
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    #[abi(embed_v0)]
    impl IValidatorAnnonceImpl of IValidatorAnnounce<ContractState> {
        /// Announces a validator signature storage location
        /// Dev: reverts if announce already occured or if wrong signer
        /// 
        /// # Arguments
        /// 
        /// * - `_validator` - The validator to consider
        /// * - `_storage_location` - Information encoding the location of signed
        /// * - `_signature` -The signed validator announcement
        /// 
        /// # Returns 
        /// 
        /// boolean -  True upon success
        fn announce(
            ref self: ContractState,
            _validator: EthAddress,
            _storage_location: Array<felt252>,
            _signature: Bytes
        ) -> bool {
            let felt252_validator: felt252 = _validator.into();
            let mut _input: Array<u256> = array![felt252_validator.into()];
            let mut u256_storage_location: Array<u256> = array![];
            let mut cur_idx = 0;
            let span_storage_location = _storage_location.span();
            loop {
                if (cur_idx == span_storage_location.len()) {
                    break ();
                }
                u256_storage_location.append((*span_storage_location.at(cur_idx)).into());
                cur_idx += 1;
            };
            let replay_id = poseidon_hash_span(
                array![felt252_validator].concat(@_storage_location).span()
            );
            assert(!self.replay_protection.read(replay_id), Errors::REPLAY_PROTECTION_ERROR);
            let announcement_digest = self.get_announcement_digest(u256_storage_location);
            let signature: Signature = convert_to_signature(_signature);
            assert(
                bool_is_eth_signature_valid(announcement_digest, signature, _validator),
                Errors::WRONG_SIGNER
            );
            match self.find_validators_index(_validator) {
                Option::Some => {},
                Option::None => {
                    let last_validator = self.find_last_validator();
                    self.validators.write(last_validator, _validator);
                }
            };
            let mut validator_len = self.storage_location_len.read(_validator);
            self.storage_locations.write((_validator, validator_len), _storage_location);
            self.storage_location_len.write(_validator, validator_len + 1);
            self.replay_protection.write(replay_id, true);
            self
                .emit(
                    ValidatorAnnouncement {
                        validator: _validator, storage_location: span_storage_location
                    }
                );
            true
        }


        /// Returns a list of all announced storage locations
        /// 
        /// # Arguments
        /// 
        /// * - `_validators` - The span of validators to get registrations for
        /// 
        /// # Returns 
        /// 
        /// Span<Span<felt252>> -  A list of registered storage metadata
        fn get_announced_storage_locations(
            self: @ContractState, mut _validators: Span<EthAddress>
        ) -> Span<Span<Array<felt252>>> {
            let mut metadata = array![];
            loop {
                match _validators.pop_front() {
                    Option::Some(validator) => {
                        let mut cur_idx = 0;
                        let validator_len = self.storage_location_len.read(*validator);
                        let mut validator_metadata = array![];
                        loop {
                            if (cur_idx == validator_len) {
                                break ();
                            }
                            validator_metadata
                                .append(self.storage_locations.read((*validator, cur_idx)));
                            cur_idx += 1;
                        };
                        metadata.append(validator_metadata.span())
                    },
                    Option::None => { break (); }
                }
            };
            metadata.span()
        }

        /// Returns a list of validators that have made announcements
        fn get_announced_validators(self: @ContractState) -> Span<EthAddress> {
            self.build_validators_array()
        }


        /// Returns the digest validators are expected to sign when signing announcements.
        /// 
        /// # Arguments
        /// 
        /// * - `_storage_location` - Storage location as array of u256
        /// 
        /// # Returns 
        /// 
        /// u256 -  The digest of the announcement.
        fn get_announcement_digest(
            self: @ContractState, mut _storage_location: Array<u256>
        ) -> u256 {
            let domain_hash = self.domain_hash();
            let mut byte_data_storage_location = array![];
            loop {
                match _storage_location.pop_front() {
                    Option::Some(storage) => {
                        byte_data_storage_location
                            .append(
                                ByteData { value: storage, size: u256_word_size(storage).into() }
                            );
                    },
                    Option::None => { break (); }
                }
            };
            let hash = reverse_endianness(
                compute_keccak(
                    array![ByteData { value: domain_hash.into(), size: HASH_SIZE }]
                        .concat(@byte_data_storage_location)
                        .span()
                )
            );
            to_eth_signature(hash)
        }
    }

    #[generate_trait]
    pub impl ValidatorAnnounceInternalImpl of InternalTrait {
        /// Returns the domain separator used in validator announcements.
        fn domain_hash(self: @ContractState) -> u256 {
            let mailbox_address: felt252 = self.mailboxclient.mailbox().try_into().unwrap();
            let mut input: Array<ByteData> = array![
                ByteData { value: self.mailboxclient.get_local_domain().into(), size: 4 },
                ByteData { value: mailbox_address.try_into().unwrap(), size: 32 },
                ByteData { value: HYPERLANE_ANNOUNCEMENT.into(), size: 22 }
            ];
            reverse_endianness(compute_keccak(input.span()))
        }

        /// Helper: finds the index associated to a given validator, if found
        /// Dev: Chained list (EthereumAddress -> EthereumAddress)
        /// 
        /// # Arguments
        /// 
        /// * - `_validator` - The validator to consider
        /// 
        /// # Returns 
        /// 
        /// EthAddress - the index of the validator in the Storage Map
        fn find_validators_index(
            self: @ContractState, _validator: EthAddress
        ) -> Option<EthAddress> {
            let mut current_validator: EthAddress = 0.try_into().unwrap();
            loop {
                let next_validator = self.validators.read(current_validator);
                if next_validator == _validator {
                    break Option::Some(current_validator);
                } else if next_validator == 0.try_into().unwrap() {
                    break Option::None;
                }
                current_validator = next_validator;
            }
        }

        /// Helper: finds the last stored validator
        fn find_last_validator(self: @ContractState) -> EthAddress {
            let mut current_validator = self.validators.read(0.try_into().unwrap());
            loop {
                let next_validator = self.validators.read(current_validator);
                if next_validator == 0.try_into().unwrap() {
                    break current_validator;
                }
                current_validator = next_validator;
            }
        }

        // Helper: builds a span of validators from the storage map
        fn build_validators_array(self: @ContractState) -> Span<EthAddress> {
            let mut index = 0.try_into().unwrap();
            let mut validators = array![];
            loop {
                let validator = self.validators.read(index);
                if (validator == 0.try_into().unwrap()) {
                    break ();
                }
                validators.append(validator);
                index = validator;
            };

            validators.span()
        }
    }

    /// Converts a byte signature into a standard singature format (see Signature structure)
    /// 
    /// # Arguments
    /// 
    /// * - ` _signature` - The byte encoded Signature
    /// 
    /// # Returns
    /// 
    /// Signature - Standardized signature
    fn convert_to_signature(_signature: Bytes) -> Signature {
        let (_, r) = _signature.read_u256(0);
        let (_, s) = _signature.read_u256(32);
        let (_, v) = _signature.read_u8(64);
        signature_from_vrs(v.try_into().unwrap(), r, s)
    }
}
