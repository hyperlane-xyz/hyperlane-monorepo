module hp_library::msg_utils {
  // use std::vector;
  use std::string::{Self, String};
  use std::bcs;
  use std::vector;

  use aptos_std::from_bcs;
  use aptos_std::aptos_hash;

  use hp_library::utils::{ extract_from_bytes, extract_from_bytes_reversed };
  
  /// Convert message data into bytes
  public fun format_message_into_bytes(
    version: u8,
    nonce: u32,
    origin: u32,
    sender: address,
    destination: u32,
    recipient: vector<u8>,
    body: vector<u8>,
  ): vector<u8> {
    let result = vector::empty<u8>();
    // convert into big-endian
    let nonce_bytes = bcs::to_bytes<u32>(&nonce); vector::reverse(&mut nonce_bytes);
    let origin_domain_bytes = bcs::to_bytes<u32>(&origin); vector::reverse(&mut origin_domain_bytes);
    let dest_domain_bytes = bcs::to_bytes<u32>(&destination); vector::reverse(&mut dest_domain_bytes);

    vector::append(&mut result, bcs::to_bytes<u8>(&version));
    vector::append(&mut result, nonce_bytes);
    vector::append(&mut result, origin_domain_bytes);
    vector::append(&mut result, bcs::to_bytes<address>(&sender));
    vector::append(&mut result, dest_domain_bytes);
    vector::append(&mut result, recipient);
    vector::append(&mut result, body);
    result
  }

  public fun id(msg: &vector<u8>): vector<u8> {
    aptos_hash::keccak256(*msg)
  }

  public fun version(bytes: &vector<u8>): u8 {
    from_bcs::to_u8(extract_from_bytes(bytes, 0, 1))
  }

  public fun nonce(bytes: &vector<u8>): u32 {
    from_bcs::to_u32(extract_from_bytes_reversed(bytes, 1, 5))
  }

  public fun origin_domain(bytes: &vector<u8>): u32 {
    from_bcs::to_u32(extract_from_bytes_reversed(bytes, 5, 9))
  }

  public fun sender(bytes: &vector<u8>): vector<u8> {
    extract_from_bytes(bytes, 9, 41)
  }  
  
  public fun dest_domain(bytes: &vector<u8>): u32 {
    from_bcs::to_u32(extract_from_bytes_reversed(bytes, 41, 45))
  }

  public fun recipient(bytes: &vector<u8>): address {
    from_bcs::to_address(extract_from_bytes(bytes, 45, 77))
  }

  public fun body(bytes: &vector<u8>): vector<u8> {
    extract_from_bytes(bytes, 77, 0)
  }

  // This is specific for Aptos cuz the target should have
  // address and module name
  // 
  /*struct HpAptosMsgBody has store {
    // 4 module name Length
    length: u32,
    // 0+[Length] Target Module Name
    target_module: String
    // 0+ Body contents
    content: vector<u8>,
  }*/
  // get module name from the message bytes
  public fun extract_module_name_from_body(body_bytes: &vector<u8>): String {
    let module_name_length = from_bcs::to_u32(extract_from_bytes_reversed(body_bytes, 0, 4));
    let module_name_bytes = extract_from_bytes(body_bytes, 4, ((4 + module_name_length) as u64));
    string::utf8(module_name_bytes)
  }

  #[test]
  fun from_bytes_test() {
    // let bytes = x"000000294500066eed000000000000000000000000339b46496d60b1b6b42e9715ded8b3d2154da0bb000138810000000000000000000000001a4d8a5ed6c93af828655e15c44eee2c2851f0d648656c6c6f21";
    let bytes = x"000000294500066eed000000000000000000000000339b46496d60b1b6b42e9715ded8b3d2154da0bb000138810000000000000000000000001a4d8a5ed6c93af828655e15c44eee2c2851f0d60000000648656c6c6f2166656c6c6f";

  }
}