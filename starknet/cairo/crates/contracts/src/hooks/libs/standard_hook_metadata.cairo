pub mod standard_hook_metadata {
    use alexandria_bytes::{Bytes, BytesTrait};

    use starknet::ContractAddress;
    struct Metadata {
        variant: u16,
        msg_value: u256,
        gas_limit: u256,
        refund_address: ContractAddress
    }


    /// Format of metadata:
    ///
    /// [0:2] variant
    /// [2:34] msg.value
    /// [34:66] Gas limit for message (IGP)
    /// [66:98] Refund address for message (IGP)
    /// [98:] Custom metadata

    const VARIANT_OFFSET: u8 = 0;
    const MSG_VALUE_OFFSET: u8 = 2;
    const GAS_LIMIT_OFFSET: u8 = 34;
    const REFUND_ADDRESS_OFFSET: u8 = 66;
    const MIN_METADATA_LENGTH: u256 = 98;

    pub const VARIANT: u8 = 1;

    #[generate_trait]
    pub impl StandardHookMetadataImpl of StandardHookMetadata {
        /// Returns the variant of the metadata.
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded standard hook metadata
        /// 
        /// # Returns
        /// 
        /// u16 -  variant of the metadata
        fn variant(_metadata: Bytes) -> u16 {
            if (_metadata.size() < VARIANT_OFFSET.into() + 2) {
                return 0;
            }
            let (_, res) = _metadata.read_u16(VARIANT_OFFSET.into());
            res
        }

        /// Returns the specified value for the message.
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded standard hook metadata
        /// * - `_default` - Default fallback value.
        /// 
        /// # Returns
        /// 
        /// u256 -  Value for the message
        fn msg_value(_metadata: Bytes, _default: u256) -> u256 {
            if (_metadata.size() < MSG_VALUE_OFFSET.into() + 32) {
                return _default;
            }
            let (_, res) = _metadata.read_u256(MSG_VALUE_OFFSET.into());
            res
        }

        /// Returns the specified gas limit for the message.
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded standard hook metadata
        /// * - `_default` - Default fallback gas limit.
        /// 
        /// # Returns
        /// 
        /// u256 -  Gas limit for the message
        fn gas_limit(_metadata: Bytes, _default: u256) -> u256 {
            if (_metadata.size() < GAS_LIMIT_OFFSET.into() + 32) {
                return _default;
            }
            let (_, res) = _metadata.read_u256(GAS_LIMIT_OFFSET.into());
            res
        }

        /// Returns the specified refund address for the message.
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded standard hook metadata
        /// * - `_default` - Default fallback refund address.
        /// 
        /// # Returns
        /// 
        /// ContractAddress -  Refund address for the message
        fn refund_address(_metadata: Bytes, _default: ContractAddress) -> ContractAddress {
            if (_metadata.size() < REFUND_ADDRESS_OFFSET.into() + 32) {
                return _default;
            }
            let (_, res) = _metadata.read_address(REFUND_ADDRESS_OFFSET.into());
            res
        }

        ///Returns any custom metadata.
        /// 
        /// # Arguments
        /// 
        /// * - `_metadata` - encoded standard hook metadata
        /// 
        /// # Returns
        /// 
        /// Bytes -  Custom metadata.
        fn get_custom_metadata(_metadata: Bytes) -> Bytes {
            if (_metadata.size().into() < MIN_METADATA_LENGTH) {
                return BytesTrait::new_empty();
            }
            let (_, res) = _metadata
                .read_bytes(
                    MIN_METADATA_LENGTH.try_into().unwrap(),
                    _metadata.size() - MIN_METADATA_LENGTH.try_into().unwrap()
                );
            res
        }

        fn format_metadata(
            msg_value: u256,
            gas_limit: u256,
            refund_address: ContractAddress,
            custom_metadata: Bytes
        ) -> Bytes {
            // NOTE: sence ContractAddress might not fit into u128, we need to convert it to u256
            // and then split it into low and high parts
            let refund_address_felt: felt252 = refund_address.into();
            let refund_address_u256: u256 = refund_address_felt.into();
            let mut data: Array<u128> = array![
                VARIANT.into(),
                msg_value.low,
                msg_value.high,
                gas_limit.low,
                gas_limit.high,
                refund_address_u256.low,
                refund_address_u256.high
            ];

            let mut formatted_metadata = BytesTrait::new(data.len(), data);
            formatted_metadata.concat(@custom_metadata);
            formatted_metadata
        }

        fn override_gas_limits(gas_limit: u256) -> Bytes {
            StandardHookMetadata::format_metadata(
                0, gas_limit, starknet::get_caller_address(), BytesTrait::new_empty()
            )
        }
    }
}


#[cfg(test)]
mod tests {
    use alexandria_bytes::{Bytes, BytesTrait};
    use starknet::{ContractAddress, contract_address_const};
    use super::standard_hook_metadata::StandardHookMetadata;
    #[test]
    fn test_standard_hook_metadata_default_value() {
        let mut metadata = BytesTrait::new_empty();
        assert_eq!(0, StandardHookMetadata::variant(metadata.clone()));
        let variant = 1;
        metadata.append_u16(variant);
        assert_eq!(123, StandardHookMetadata::msg_value(metadata.clone(), 123));
        let msg_value = 0x123123123;
        metadata.append_u256(msg_value);
        assert_eq!(4567, StandardHookMetadata::gas_limit(metadata.clone(), 4567));
        let gas_limit = 0x456456456;
        metadata.append_u256(gas_limit);
        let other_refunded_address = 'other_refunded'.try_into().unwrap();
        assert_eq!(
            other_refunded_address,
            StandardHookMetadata::refund_address(metadata.clone(), other_refunded_address)
        );
        let refund_address: ContractAddress = 'refund_address'.try_into().unwrap();
        metadata.append_address(refund_address);
    }

    #[test]
    fn test_standard_hook_metadata() {
        let mut metadata = BytesTrait::new_empty();
        let variant = 1;
        let msg_value = 0x123123123;
        let gas_limit = 0x456456456;
        let refund_address: ContractAddress = 'refund_address'.try_into().unwrap();
        let custom_metadata = array![0x123123123123, 0x123123123];
        metadata.append_u16(variant);
        metadata.append_u256(msg_value);
        metadata.append_u256(gas_limit);
        metadata.append_address(refund_address);
        metadata.append_u256(*custom_metadata.at(0));
        metadata.append_u256(*custom_metadata.at(1));
        let mut expected_custom_metadata = BytesTrait::new_empty();
        expected_custom_metadata.append_u256(*custom_metadata.at(0));
        expected_custom_metadata.append_u256(*custom_metadata.at(1));
        assert_eq!(variant, StandardHookMetadata::variant(metadata.clone()));
        assert_eq!(msg_value, StandardHookMetadata::msg_value(metadata.clone(), 0));
        assert_eq!(gas_limit, StandardHookMetadata::gas_limit(metadata.clone(), 0));
        assert_eq!(
            refund_address,
            StandardHookMetadata::refund_address(metadata.clone(), contract_address_const::<0>())
        );
        assert(
            expected_custom_metadata == StandardHookMetadata::get_custom_metadata(metadata.clone()),
            'SHM: custom metadata mismatch'
        );
    }
}
