use alexandria_bytes::{Bytes, BytesTrait, BytesStore};
use alexandria_math::BitShift;
use contracts::utils::keccak256::{
    reverse_endianness, compute_keccak, ByteData, u256_word_size, u64_word_size, ADDRESS_SIZE,
    u128_mask,
};
use starknet::{ContractAddress, contract_address_const};

pub const HYPERLANE_VERSION: u8 = 3;


#[derive(Serde, starknet::Store, Drop, Clone)]
pub struct Message {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: u256,
    pub destination: u32,
    pub recipient: u256,
    pub body: Bytes,
}


#[generate_trait]
pub impl MessageImpl of MessageTrait {
    /// Generate a default empty message
    /// 
    ///  # Returns
    /// 
    /// * An empty message structure
    fn default() -> Message {
        Message {
            version: HYPERLANE_VERSION,
            nonce: 0_u32,
            origin: 0_u32,
            sender: 0,
            destination: 0_u32,
            recipient: 0,
            body: BytesTrait::new_empty(),
        }
    }

    /// Format an input message, using 
    /// 
    /// # Arguments
    /// 
    /// * `_message` - Message to hash
    /// 
    ///  # Returns
    /// 
    /// * u256 representing the hash of the message
    fn format_message(_message: Message) -> (u256, Message) {
        let mut input: Array<ByteData> = array![
            ByteData { value: _message.version.into(), size: 1 },
            ByteData { value: _message.nonce.into(), size: 4 },
            ByteData { value: _message.origin.into(), size: 4 },
            ByteData { value: _message.sender, size: 32 },
            ByteData { value: _message.destination.into(), size: 4 },
            ByteData { value: _message.recipient, size: 32 },
        ];
        let message_data = _message.clone().body.data();
        let finalized_input = MessageImpl::append_span_u128_to_byte_data(
            input, message_data.span(), _message.clone().body.size()
        );
        (reverse_endianness(compute_keccak(finalized_input)), _message)
    }

    fn append_span_u128_to_byte_data(
        mut _input: Array<ByteData>, _to_append: Span<u128>, size: u32
    ) -> Span<ByteData> {
        let mut cur_idx = 0;
        let range = size / 16;
        loop {
            if (cur_idx == range) {
                if (size % 16 == 0) {
                    break;
                } else {
                    let remaining_size = size - cur_idx * 16;
                    let mask = u128_mask(remaining_size.try_into().unwrap());
                    _input
                        .append(
                            ByteData {
                                value: (BitShift::shr(
                                    *_to_append.at(cur_idx), ((16 - remaining_size) * 8).into()
                                )
                                    & mask)
                                    .into(),
                                size: remaining_size
                            }
                        );
                    break;
                }
            }
            _input.append(ByteData { value: (*_to_append.at(cur_idx)).into(), size: 16 });
            cur_idx += 1;
        };
        _input.span()
    }
}


#[cfg(test)]
mod tests {
    use super::{MessageImpl, ByteData};

    #[test]
    fn test_append_u128_to_byte_array() {
        let input: Array<u128> = array![
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
            0xcc000000000000000000000000000000
        ];
        let output_array = MessageImpl::append_span_u128_to_byte_data(array![], input.span(), 33);
        assert_eq!(
            output_array,
            array![
                ByteData { value: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, size: 16 },
                ByteData { value: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, size: 16 },
                ByteData { value: 0xcc, size: 1 }
            ]
                .span()
        );

        let input: Array<u128> = array![
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
            0xcccccccccccccccccccccccccccccccc
        ];
        let output_array = MessageImpl::append_span_u128_to_byte_data(array![], input.span(), 48);
        assert_eq!(
            output_array,
            array![
                ByteData { value: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, size: 16 },
                ByteData { value: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, size: 16 },
                ByteData { value: 0xcccccccccccccccccccccccccccccccc, size: 16 }
            ]
                .span()
        );

        let input: Array<u128> = array![
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
            0xcccccccccccccccccccccccccccccc00
        ];
        let output_array = MessageImpl::append_span_u128_to_byte_data(array![], input.span(), 47);
        assert_eq!(
            output_array,
            array![
                ByteData { value: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, size: 16 },
                ByteData { value: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, size: 16 },
                ByteData { value: 0xcccccccccccccccccccccccccccccc, size: 15 }
            ]
                .span()
        );

        let input: Array<u128> = array![
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
            0xcccccccccccccccccccccccccc000000
        ];
        let output_array = MessageImpl::append_span_u128_to_byte_data(array![], input.span(), 45);
        assert_eq!(
            output_array,
            array![
                ByteData { value: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, size: 16 },
                ByteData { value: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, size: 16 },
                ByteData { value: 0xcccccccccccccccccccccccccc, size: 13 }
            ]
                .span()
        );

        let input: Array<u128> = array![0x12345678000000000000000000000000];
        let output_array = MessageImpl::append_span_u128_to_byte_data(array![], input.span(), 4);
        assert_eq!(output_array, array![ByteData { value: 0x12345678, size: 4 }].span());
    }
}
