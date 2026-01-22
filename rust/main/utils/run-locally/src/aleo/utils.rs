use aleo_serialize::AleoSerialize;
use bech32::FromBase32;
use snarkvm::prelude::{bech32, MainnetV0};

pub(crate) fn get_program_address(address: &str) -> [u8; 32] {
    let addr_bytes = bech32::decode(address)
        .expect("Failed to decode component address")
        .1
        .to_vec();
    let addr_bytes = Vec::<u8>::from_base32(&addr_bytes).expect("Failed to convert from base32");
    let mut addr_array = [0u8; 32];
    addr_array.copy_from_slice(&addr_bytes[..32]);
    addr_array
}

pub(crate) fn domain_u32(domain: u32) -> String {
    format!("{domain}u32")
}

pub(crate) fn to_plaintext_string<T>(val: &T) -> String
where
    T: AleoSerialize<MainnetV0>,
{
    T::to_plaintext(val).expect("pt").to_string()
}

pub(crate) fn encode_fixed_program_name(name: &str) -> String {
    let mut bytes = [0u8; 128];
    let name_b = name.as_bytes();
    bytes[..name_b.len()].copy_from_slice(name_b);
    to_plaintext_string(&bytes)
}
