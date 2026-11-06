extern crate ethers_core;

use ethers_core::abi::{AbiDecode, AbiEncode, FunctionExt, HumanReadableParser, Token};
use ethers_core::types::{Bytes, H160, U256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn print_chunks(name: &str, bytes: &[u8]) {
    println!("{name}: {} bytes", bytes.len());
    for chunk in bytes.chunks(16) {
        println!("\"{}\",", hex(chunk));
    }
}

fn main() {
    let aggregate3 = HumanReadableParser::parse_function(
        "function aggregate3((address,bool,bytes)[] calls) returns ((bool,bytes)[] returnData)",
    )
    .unwrap();
    let aggregate3_value = HumanReadableParser::parse_function(
        "function aggregate3Value((address,bool,uint256,bytes)[] calls) returns ((bool,bytes)[] returnData)",
    )
    .unwrap();
    assert_eq!(aggregate3.selector(), [0x82, 0xad, 0x56, 0xcb]);
    assert_eq!(aggregate3_value.selector(), [0x17, 0x4d, 0xea, 0x71]);

    let first_address = H160::repeat_byte(0x11);
    let second_address = H160::repeat_byte(0x22);
    let first_data = vec![0xde, 0xad, 0xbe, 0xef];
    let second_data = vec![1, 2, 3, 4, 5];
    let zero_calls = vec![
        Token::Tuple(vec![
            Token::Address(first_address),
            Token::Bool(true),
            Token::Bytes(first_data.clone()),
        ]),
        Token::Tuple(vec![
            Token::Address(second_address),
            Token::Bool(true),
            Token::Bytes(second_data.clone()),
        ]),
    ];
    let value_calls = vec![
        Token::Tuple(vec![
            Token::Address(first_address),
            Token::Bool(true),
            Token::Uint(U256::zero()),
            Token::Bytes(first_data),
        ]),
        Token::Tuple(vec![
            Token::Address(second_address),
            Token::Bool(true),
            Token::Uint(U256::from(7)),
            Token::Bytes(second_data),
        ]),
    ];
    let zero = aggregate3
        .encode_input(&[Token::Array(zero_calls)])
        .unwrap();
    let nonzero = aggregate3_value
        .encode_input(&[Token::Array(value_calls)])
        .unwrap();

    let reason = "denied";
    let mut revert = ethers_core::utils::id("Error(string)")[..4].to_vec();
    revert.extend(ethers_core::abi::encode(&[Token::String(reason.into())]));
    let results = vec![
        (true, Bytes::from(vec![0xca, 0xfe])),
        (false, Bytes::from(revert.clone())),
    ];
    let encoded_results = results.clone().encode();
    let decoded = <Vec<(bool, Bytes)> as AbiDecode>::decode(&encoded_results).unwrap();
    assert_eq!(decoded, results);
    assert_eq!(<String as AbiDecode>::decode(&revert[4..]).unwrap(), reason);

    print_chunks("aggregate3_zero", &zero);
    print_chunks("aggregate3_value_total_7", &nonzero);
    print_chunks("aggregate3_results", &encoded_results);
    print_chunks("error_string_denied", &revert);
}
