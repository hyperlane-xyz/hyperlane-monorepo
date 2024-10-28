use alexandria_math::BitShift;
use contracts::libs::checkpoint_lib::checkpoint_lib::HYPERLANE_ANNOUNCEMENT;
use core::byte_array::{ByteArray, ByteArrayTrait};
use core::integer::u128_byte_reverse;
use core::keccak::cairo_keccak;
use core::starknet::SyscallResultTrait;
use core::to_byte_array::{FormatAsByteArray, AppendFormattedToByteArray};
use starknet::{EthAddress, eth_signature::is_eth_signature_valid, secp256_trait::Signature};

pub const ETH_SIGNED_MESSAGE: felt252 = '\x19Ethereum Signed Message:\n32';


// TYPE DEFINITION
type Words64 = Span<u64>;

// CONSTANTS DEFINITION

pub const ONE_SHIFT_64: u128 = 0x10000000000000000;
pub const FELT252_MASK: u256 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
pub const ADDRESS_SIZE: usize = 32;
pub const HASH_SIZE: usize = 32;
const KECCAK_FULL_RATE_IN_U64S: usize = 17;

/// 
/// Structure specifying for each element, the value of this element as u256 and the size (in bytes) of this element 
/// 
#[derive(Copy, Drop, Serde, starknet::Store, Debug, PartialEq)]
pub struct ByteData {
    pub value: u256,
    pub size: usize
}

fn zero_keccak_hash(index: u32) -> u256 {
    let zero_hashes = array![
        0x70a4855d04d8fa7b3b2782ca53b600e5c003c7dcb27d7e923c23f7860146d2c5,
        0x8ac9bc64e0a996ff9165d677b4f712667d818f822942463614281e7a9e7836bc,
        0x9867d524c957cd4a34ab5cb41cf07a61b9a21b01fd478bb4bf153c65abc0a854,
        0x4786f66fb0dfef4cc6c44c8c079a50602ceb5ae16212a13195fce125910dff99,
        0x4c24d3cb4a3a6364b152e840bd5e68f7b70bbf4b7b4c3655b9736f582676e7e8,
        0xec20d0c108ce727d4435781105cb4c026a879dd1da80204aea049855e78915c4,
        0xb3d5b06f1965e76affc51cc6f4fd3573c17aca0e130b851b1b082ee0a5e13750,
        0x2fee92aa6bc7129f61059dec151e37832a0c5391ff956a0501a55e7254e0cbdf,
        0xce7b1eba890df1f0c6e5831b1d7f164b7e814c9ccf439104f1018cdd034d1b01,
        0x715325eaf93144c3121df9be1e502565203c8c2d1c7d8cab1625d69d205e31ad,
        0x07b634fd0ff4184560dbb4b1f8fb1246c6fd24bf58934233eecb08d46bddd26b,
        0xc4885e2eaa4fe0e9a9a4b9a9bd5468438b29849c0d56a2eae38807d900039c6f,
        0x1173b4507b58cf903327ca3b7f6b2b18e6c4a14fc58c1a8a213c2faddabfe230,
        0x57e542ab2576985e8144bb5c35db1189474ea3fb34f456db95044b5286fc8431,
        0xdda769b8a7519cf92bc60f37373ea91d07ec8114c189833b9e3a512ed7c86691,
        0xc0a98ba674651a884e48389eb69e8735e12c90b4faed3106cb58f4d8e93910bf,
        0xb42369a2f775c0b3d24d3ab0e99b6fc728aa52882013ebab5fa3c82029de90f4,
        0x6d99cc2723be666f8d40e78fc5198f83792aaa7f41a5d71bfe9d5822ba7e7d5b,
        0x278b338d887ab8cc46e85863c221336c9d3b27cb6e6114b9070409cdecf38a5d,
        0x7bb968fd99be569582d15c8d43c9148fd5558ca10c9c70de9b57488ec2fd2954,
        0x2a316717a4aa2d60bed23e95fc3595fdd71f4ade789c8db98ea581aeb7c78053,
        0x584efaff23ec6158ce7d30ca6b514abb1892923e656c973c21a193c40571655a,
        0x0e89b39caa331523d4b98c3abdae38563bed440ec164ac81ecc738804bd46255,
        0xd8383520305dd28bde1cef07a7234d4381a1c9bad3aba3a9bf050b43f9f9b9e2,
        0xcd5c4ff8dae018efefdba2ebf35857546284b6b8912cceecbda0a2bd9b657b82,
        0xaba91af7fd52ef0bceaaee96fc1fc46feb087fb1985720e739cdc5b6b11dd4c0,
        0xb2dc520d17b9a82a12f5ec7af5ed8882b468b7a3f8492188181c2c4448db33a5,
        0x5d1e89019bf642bbc63a008d7aef19c40a461dcf7adade5029ca4592802f6459,
        0x2ec59c21bd5581d0c5b10d6b392a2d40a0ce500e29ccb5c7f75d50a01e0396b6,
        0x6f00c6b91b5194e948cefb0042862c5f36525b11ccf87581a3debd79cbcd1c47,
        0x7c312f53e36ec8bcca3e9530f94cc0d5acc3fd2cdf88258cd72e52321ce748f5,
        0xcfb409c77e66d490e1b4b57818f255deb978c8415aecf3952d51991445d0fe15,
        0x63e5f30e16932f36f608404895bca64bc86f3888a94503d6a8628b54d9ec0d29
    ];
    *zero_hashes.at(index)
}

/// Reverses the endianness of an u256
/// 
/// # Arguments
/// 
/// * `value` - Value to reverse
/// 
/// # Returns 
/// 
/// the reverse equivalent 
pub fn reverse_endianness(value: u256) -> u256 {
    let new_low = u128_byte_reverse(value.high);
    let new_high = u128_byte_reverse(value.low);
    u256 { low: new_low, high: new_high }
}


/// Determines the Ethereum compatible signature for a given hash
/// dev : Since call this function for hash only, the ETH_SIGNED_MESSAGE size will always be 32
/// 
///  # Arguments
/// 
///  * `hash` - Hash to sign
/// 
/// # Returns the corresponding hash as big endian
pub fn to_eth_signature(hash: u256) -> u256 {
    let input = array![
        ByteData {
            value: ETH_SIGNED_MESSAGE.into(), size: u256_word_size(ETH_SIGNED_MESSAGE.into()).into()
        },
        ByteData { value: hash, size: HASH_SIZE }
    ];
    let hash = compute_keccak(input.span());
    reverse_endianness(hash)
}

/// Determines the correctness of an ethereum signature given a digest, signer and signature 
/// 
/// # Arguments 
/// 
/// * - `_msg_hash` - to digest used to sign the message
/// * - `_signature` - the signature to check
/// * - `_signer` - the signer ethereum address
/// 
/// # Returns 
/// 
/// boolean - True if valid
pub fn bool_is_eth_signature_valid(
    msg_hash: u256, signature: Signature, signer: EthAddress
) -> bool {
    match is_eth_signature_valid(msg_hash, signature, signer) {
        Result::Ok(()) => true,
        Result::Err(_) => false
    }
}


/// Determines the size of a u64 element, by successive division 
///
/// # Arguments
/// 
/// * `word` - u64 word to consider
/// 
/// # Returns
/// 
/// The size (in bytes) for the given word
pub fn u64_word_size(word: u64) -> u8 {
    let mut word_len = 0;
    while word_len < 8 {
        if word < one_shift_left_bytes_u64(word_len) {
            break;
        }
        word_len += 1;
    };
    word_len
}


/// Determines the size of a u256 element, by successive division 
///
/// # Arguments
/// 
/// * `word` - u256 word to consider
/// 
/// # Returns
/// 
/// The size (in bytes) for the given word
pub fn u256_word_size(word: u256) -> u8 {
    let mut word_len = 0;
    while word_len < 32 {
        if word < one_shift_left_bytes_u256(word_len) {
            break;
        }
        word_len += 1;
    };
    word_len
}


/// Shifts helper for u64
/// dev : panics if u64 overflow
/// 
/// # Arguments
/// 
/// * `n_bytes` - The number of bytes shift 
/// 
/// # Returns 
/// 
/// u64 representing the shifting number associated to the given number
pub fn one_shift_left_bytes_u64(n_bytes: u8) -> u64 {
    match n_bytes {
        0 => 0x1,
        1 => 0x100,
        2 => 0x10000,
        3 => 0x1000000,
        4 => 0x100000000,
        5 => 0x10000000000,
        6 => 0x1000000000000,
        7 => 0x100000000000000,
        _ => core::panic_with_felt252('n_bytes too big'),
    }
}


/// Shifts helper for u256
/// dev : panics if u256 overflow
/// 
/// # Arguments
/// 
/// * `n_bytes` - The number of bytes shift 
/// 
/// # Returns 
/// 
/// u256 representing the shifting number associated to the given number
pub fn one_shift_left_bytes_u256(n_bytes: u8) -> u256 {
    match n_bytes {
        0 => 0x1,
        1 => 0x100,
        2 => 0x10000,
        3 => 0x1000000,
        4 => 0x100000000,
        5 => 0x10000000000,
        6 => 0x1000000000000,
        7 => 0x100000000000000,
        8 => 0x10000000000000000,
        9 => 0x1000000000000000000,
        10 => 0x100000000000000000000,
        11 => 0x10000000000000000000000,
        12 => 0x1000000000000000000000000,
        13 => 0x100000000000000000000000000,
        14 => 0x10000000000000000000000000000,
        15 => 0x1000000000000000000000000000000,
        16 => 0x100000000000000000000000000000000,
        17 => 0x10000000000000000000000000000000000,
        18 => 0x1000000000000000000000000000000000000,
        19 => 0x100000000000000000000000000000000000000,
        20 => 0x10000000000000000000000000000000000000000,
        21 => 0x1000000000000000000000000000000000000000000,
        22 => 0x100000000000000000000000000000000000000000000,
        23 => 0x10000000000000000000000000000000000000000000000,
        24 => 0x1000000000000000000000000000000000000000000000000,
        25 => 0x100000000000000000000000000000000000000000000000000,
        26 => 0x10000000000000000000000000000000000000000000000000000,
        27 => 0x1000000000000000000000000000000000000000000000000000000,
        28 => 0x100000000000000000000000000000000000000000000000000000000,
        29 => 0x10000000000000000000000000000000000000000000000000000000000,
        30 => 0x1000000000000000000000000000000000000000000000000000000000000,
        31 => 0x100000000000000000000000000000000000000000000000000000000000000,
        _ => core::panic_with_felt252('n_bytes too big'),
    }
}

/// Shifts equivalent u128 mask for a given number of bytes
/// dev : panics if u128 overflow
/// 
/// # Arguments
/// 
/// * `n_bytes` - The number of bytes shift 
/// 
/// # Returns 
/// 
/// u256 representing the associated mask
pub fn u128_mask(n_bytes: u8) -> u128 {
    match n_bytes {
        0 => 0,
        1 => 0xFF,
        2 => 0xFFFF,
        3 => 0xFFFFFF,
        4 => 0xFFFFFFFF,
        5 => 0xFFFFFFFFFF,
        6 => 0xFFFFFFFFFFFF,
        7 => 0xFFFFFFFFFFFFFF,
        8 => 0xFFFFFFFFFFFFFFFF,
        9 => 0xFFFFFFFFFFFFFFFFFF,
        10 => 0xFFFFFFFFFFFFFFFFFFFF,
        11 => 0xFFFFFFFFFFFFFFFFFFFFFF,
        12 => 0xFFFFFFFFFFFFFFFFFFFFFFFF,
        13 => 0xFFFFFFFFFFFFFFFFFFFFFFFFFF,
        14 => 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
        15 => 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
        16 => 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
        _ => core::panic_with_felt252('n_bytes too big'),
    }
}

/// Givens a span of ByteData, returns a concatenated string (ByteArray) of the input
/// 
/// # Arguments
/// 
/// * `bytes` - a span of ByteData containing the information that need to be hash
/// 
/// # Returns 
/// 
/// ByteArray representing the concatenation of the input (bytes31). 
fn concatenate_input(bytes: Span<ByteData>) -> ByteArray {
    let mut output_string: ByteArray = Default::default();
    let mut cur_idx = 0;
    loop {
        if cur_idx == bytes.len() {
            break;
        }
        let byte = *bytes.at(cur_idx);
        if byte.size == 32 {
            // Extract the upper 1-byte part
            let up_byte = up_bytes(byte.value);
            output_string.append_word(up_byte.try_into().unwrap(), 1);

            // Extract the lower 31-byte part
            let down_byte = down_bytes(byte.value);
            output_string.append_word(down_byte.try_into().unwrap(), 31);
        } else {
            output_string.append_word(byte.value.try_into().unwrap(), byte.size);
        }
        cur_idx += 1;
    };
    output_string
}


// --------------------------------------------------------
// This section is part of the cairo core contract (see: https://github.com/starkware-libs/cairo/blob/953afd5e7ede296c99deaf189e18e361229517c0/corelib/src/keccak.cairo)
pub fn compute_keccak_byte_array(arr: @ByteArray) -> u256 {
    let mut input = array![];
    let mut i = 0;
    let mut inner = 0;
    let mut limb: u64 = 0;
    let mut factor: u64 = 1;
    while let Option::Some(b) = arr
        .at(i) {
            limb = limb + b.into() * factor;
            i += 1;
            inner += 1;
            if inner == 8 {
                input.append(limb);
                inner = 0;
                limb = 0;
                factor = 1;
            } else {
                factor *= 0x100;
            }
        };
    add_padding(ref input, limb, inner);
    starknet::syscalls::keccak_syscall(input.span()).unwrap_syscall()
}


/// The padding in keccak256 is "1 0* 1".
/// `last_input_num_bytes` (0-7) is the number of bytes in the last u64 input - `last_input_word`.
fn add_padding(ref input: Array<u64>, last_input_word: u64, last_input_num_bytes: usize) {
    let words_divisor = KECCAK_FULL_RATE_IN_U64S.try_into().unwrap();
    // `last_block_num_full_words` is in range [0, KECCAK_FULL_RATE_IN_U64S - 1]
    let (_, last_block_num_full_words) = core::integer::u32_safe_divmod(input.len(), words_divisor);

    // The first word to append would be of the form
    //     0x1<`last_input_num_bytes` LSB bytes of `last_input_word`>.
    // For example, for `last_input_num_bytes == 4`:
    //     0x1000000 + (last_input_word & 0xffffff)
    let first_word_to_append = if last_input_num_bytes == 0 {
        // This case is handled separately to avoid unnecessary computations.
        1
    } else {
        let first_padding_byte_part = if last_input_num_bytes == 1 {
            0x100
        } else if last_input_num_bytes == 2 {
            0x10000
        } else if last_input_num_bytes == 3 {
            0x1000000
        } else if last_input_num_bytes == 4 {
            0x100000000
        } else if last_input_num_bytes == 5 {
            0x10000000000
        } else if last_input_num_bytes == 6 {
            0x1000000000000
        } else if last_input_num_bytes == 7 {
            0x100000000000000
        } else {
            core::panic_with_felt252('Keccak last input word >7b')
        };
        let (_, r) = core::integer::u64_safe_divmod(
            last_input_word, first_padding_byte_part.try_into().unwrap()
        );
        first_padding_byte_part + r
    };

    if last_block_num_full_words == KECCAK_FULL_RATE_IN_U64S - 1 {
        input.append(0x8000000000000000 + first_word_to_append);
        return;
    }

    // last_block_num_full_words < KECCAK_FULL_RATE_IN_U64S - 1
    input.append(first_word_to_append);
    finalize_padding(ref input, KECCAK_FULL_RATE_IN_U64S - 1 - last_block_num_full_words);
}

/// Finalize the padding by appending "0* 1".
fn finalize_padding(ref input: Array<u64>, num_padding_words: u32) {
    if (num_padding_words == 1) {
        input.append(0x8000000000000000);
        return;
    }

    input.append(0);
    finalize_padding(ref input, num_padding_words - 1);
}


// --------------------------------------------------------------------------------------------
// END SECTION
/// Retrieve the 1 up byte of a given u256 input
fn up_bytes(input: u256) -> u256 {
    BitShift::shr(input, 248) & 0xFF
}

/// Retrieve the 31 low byte of a given u256 input
fn down_bytes(input: u256) -> u256 {
    input & FELT252_MASK
}

/// The general function that computes the keccak hash for an input span of ByteData
/// 
/// # Arguments
/// 
/// * `bytes` - a span of ByteData containing the information for the hash computation
/// 
/// # Returns
/// 
/// The corresponding keccak hash for the input arguments
pub fn compute_keccak(bytes: Span<ByteData>) -> u256 {
    if (bytes.is_empty()) {
        return zero_keccak_hash(0);
    }
    if (*bytes.at(0).value == 0 && bytes.len() == 1) {
        return zero_keccak_hash(*bytes.at(0).size);
    }
    let concatenate_input = concatenate_input(bytes);
    compute_keccak_byte_array(@concatenate_input)
}


#[cfg(test)]
mod tests {
    use alexandria_bytes::{Bytes, BytesTrait};
    use starknet::contract_address_const;
    use super::{
        reverse_endianness, ByteData, HYPERLANE_ANNOUNCEMENT, compute_keccak, u64_word_size,
        zero_keccak_hash, ADDRESS_SIZE, up_bytes, down_bytes
    };
    const TEST_STARKNET_DOMAIN: u32 = 23448594;

    #[test]
    fn test_up_bytes() {
        let input = 0x01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        let expected = 0x01;
        assert_eq!(up_bytes(input), expected);

        let input = 0x11FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        let expected = 0x11;
        assert_eq!(up_bytes(input), expected);

        let input = 0x11;
        let expected = 0;
        assert_eq!(up_bytes(input), expected);
    }
    #[test]
    fn test_down_bytes() {
        let input = 0x01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        let expected = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        assert_eq!(down_bytes(input), expected);

        let input = 0x0100FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        let expected = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
        assert_eq!(down_bytes(input), expected);
    }

    #[test]
    fn test_reverse_endianness() {
        let big_endian_number: u256 = u256 { high: 0x12345678, low: 0 };
        let expected_result: u256 = u256 { high: 0, low: 0x78563412000000000000000000000000 };
        assert(
            reverse_endianness(big_endian_number) == expected_result, 'Failed to realise reverse'
        );
    }

    #[test]
    fn test_compute_keccak() {
        let array = array![ByteData { value: HYPERLANE_ANNOUNCEMENT.into(), size: 22 }];
        assert_eq!(
            compute_keccak(array.span()),
            0x4CE82A3F02824445F403FB5B69D4AB0FFFFC358BBAF61B0A130C971AB0CB15DA
        );

        let array = array![
            ByteData {
                value: 0x007a9a2e1663480b3845df0d714e8caa49f9241e13a826a678da3f366e546f2a,
                size: ADDRESS_SIZE
            }
        ];
        assert_eq!(
            compute_keccak(array.span()),
            0x9D3185A7830200BD62EF9D26D44D9169A544C1FFA0FB98D0D56AAAA3BA8FE354
        );

        let array = array![ByteData { value: TEST_STARKNET_DOMAIN.into(), size: 4 }];
        assert_eq!(
            compute_keccak(array.span()),
            0xBC54A343AEF444F26F67F8538FE9F045A340D250AE50D019CB7528444FA32AEC
        );

        let array = array![
            ByteData { value: TEST_STARKNET_DOMAIN.into(), size: 4 },
            ByteData {
                value: 0x007a9a2e1663480b3845df0d714e8caa49f9241e13a826a678da3f366e546f2a,
                size: ADDRESS_SIZE
            }
        ];
        assert_eq!(
            compute_keccak(array.span()),
            0x5DD6FF889DE1B20CF9B497A6716210C826DE3739FCAF50CD66F42F1DBE8626F2
        );

        let array = array![
            ByteData { value: TEST_STARKNET_DOMAIN.into(), size: 4 },
            ByteData {
                value: 0x007a9a2e1663480b3845df0d714e8caa49f9241e13a826a678da3f366e546f2a,
                size: ADDRESS_SIZE
            },
            ByteData { value: HYPERLANE_ANNOUNCEMENT.into(), size: 22 }
        ];
        assert_eq!(
            compute_keccak(array.span()),
            0xFD8977CB20EE179678A5008D11A591D101FBDCC7669BC5CA31B92439A7E7FB4E
        );

        let array = array![
            ByteData {
                value: 0x61a4bcca63b5e8a46da3abe2080f75c16c18467d5838f00b375d9ba4c7c313dd,
                size: ADDRESS_SIZE
            },
            ByteData {
                value: 0x49d35915d0abec0a28990198bb32aa570e681e7eb41a001c0094c7c36a712671,
                size: ADDRESS_SIZE
            }
        ];
        assert_eq!(
            compute_keccak(array.span()),
            0x8310DAC21721349FCFA72BB5499303F0C6FAB4006FA2A637D02F7D6BB2188B47
        );

        let array = array![ByteData { value: 0, size: 1 }];
        assert_eq!(compute_keccak(array.span()), zero_keccak_hash(1));

        let array = array![
            ByteData { value: 0, size: 10 },
            ByteData {
                value: 0x007a9a2e1663480b3845df0d714e8caa49f9241e13a826a678da3f366e546f2a, size: 32
            },
        ];
        assert_eq!(
            compute_keccak(array.span()),
            0xA9EC21A66254DD00FA8F01E445CACEAA0D16A1E91700C85FB3ED6C1229B38D2A
        );
    }

    #[test]
    fn test_u64_word_size() {
        let test = 0x12345;
        assert_eq!(u64_word_size(test), 3);
        let test = 0x1234567890;
        assert_eq!(u64_word_size(test), 5);
        let test = 0xfffffffffffffff;
        assert_eq!(u64_word_size(test), 8);
        let test = 0xfff;
        assert_eq!(u64_word_size(test), 2);
        let test = 0x123456;
        assert_eq!(u64_word_size(test), 3);
        let test = 0x1;
        assert_eq!(u64_word_size(test), 1);
    }
}
