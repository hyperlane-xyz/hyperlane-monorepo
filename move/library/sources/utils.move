module hp_library::utils {
  use std::vector;
  use std::bcs;
  use std::option::{Self, Option};
  use std::string;
  use aptos_std::string_utils;
  use aptos_std::aptos_hash;
  use aptos_std::secp256k1::{Self, ECDSASignature, ECDSARawPublicKey};

  /// Aptos Module Version
  const VERSION: u8 = 0;

  const ERROR_INVALID_RECOVERY_ID: u64 = 0x333;

  public fun get_version(): u8 { VERSION }

  /// Extract a slice of bytes from bytes vector
  /// If `end` is 0, it means end of length
  public fun extract_from_bytes(bytes: &vector<u8>, start: u64, end: u64): vector<u8> {
    let extract_result = vector::empty<u8>();
    let index = start;
    let length = vector::length(bytes);

    let extract_end = end;
    // if `end` is 0 or `end` overflows length, limit `end` to length
    if (end == 0 || end > length) extract_end = length;

    // extract from the bytes, push into the result
    while (index < extract_end) {
      let byte = vector::borrow(bytes, index);
      vector::push_back(&mut extract_result, *byte);
      index = index + 1;
    };

    extract_result
  }

  /// Reverse final result of extraction to make Little Endian
  public fun extract_from_bytes_reversed(bytes: &vector<u8>, start: u64, end: u64): vector<u8> {
    let result = extract_from_bytes(bytes, start, end);
    vector::reverse(&mut result);
    result
  }

  /// Fill vector with the given value
  public fun fill_vector<T: copy + drop>(container: &mut vector<T>, item: T, count: u64) {
    let i = 0;
    while (i < count) {
      vector::push_back(container, item);
      i = i + 1;
    };
  }

  /// Helper to return the concat'd vector
	inline fun append(
		v1: vector<u8>,
		v2: vector<u8>,
	): vector<u8> {
		vector::append(&mut v1, v2);
		v1
	}

  /// Helper to return the concat'd hash
  public inline fun hash_concat(x: vector<u8>, y: vector<u8>): vector<u8> {
    let z = append(x, y);
    aptos_hash::keccak256(z)
  }
  
  /// Helper to compare [ethereum address](vector) and [bytes from aptos-typed address](address)
  public inline fun compare_bytes_and_address(x: &vector<u8>, y: &address): bool {
    // 32-bytes format, whereas x is 20-bytes format
    let y_bytes = bcs::to_bytes<address>(y);
    
    // extend x to 32-bytes format
    let prefix_12_bytes: vector<u8> = vector[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    vector::append(&mut prefix_12_bytes, *x);

    // compare now
    prefix_12_bytes == y_bytes
  }

  /// Returns the digest validators are expected to sign when signing checkpoints.
  public fun ism_checkpoint_hash(
    origin_mailbox: address,
    origin_domain: u32,
    merkle_root: vector<u8>,
    nonce: u32,
    message_id: vector<u8>
  ): vector<u8> {
    
    let result: vector<u8> = vector::empty();
    vector::append(&mut result, ism_domain_hash(origin_mailbox, origin_domain));
    vector::append(&mut result, merkle_root);

    // make big endian bytes
    let nonce_bytes = bcs::to_bytes<u32>(&nonce);
    vector::reverse(&mut nonce_bytes);

    vector::append(&mut result, nonce_bytes);
    vector::append(&mut result, message_id);
    aptos_hash::keccak256(result)
  }

  /// Returns the domain hash that validators are expected to use when signing checkpoints.
  public fun ism_domain_hash(
    origin_mailbox: address,
    origin_domain: u32,
  ): vector<u8> {
    let result: vector<u8> = vector::empty();
    
    // make big endian bytes
    let domain_bytes = bcs::to_bytes<u32>(&origin_domain);
    vector::reverse(&mut domain_bytes);

    vector::append(&mut result, domain_bytes);
    vector::append(&mut result, bcs::to_bytes<address>(&origin_mailbox));
    vector::append(&mut result, b"HYPERLANE");
    aptos_hash::keccak256(result)
  }

  /// Returns the digest validators are expected to sign when signing announcements.
  public fun announcement_digest(
    origin_mailbox: address,
    origin_domain: u32,
  ): vector<u8> {
    let result: vector<u8> = vector::empty();
    
    // make big endian bytes
    let domain_bytes = bcs::to_bytes<u32>(&origin_domain);
    vector::reverse(&mut domain_bytes);

    vector::append(&mut result, domain_bytes);
    vector::append(&mut result, bcs::to_bytes<address>(&origin_mailbox));
    vector::append(&mut result, b"HYPERLANE_ANNOUNCEMENT");
    aptos_hash::keccak256(result)
  }

  /// Transform message into ethereum hash type
  public fun eth_signed_message_hash(message: &vector<u8>): vector<u8> {
    let message_len = vector::length(message);
    let result: vector<u8> = vector::empty();
    vector::append(&mut result, *string::bytes(&string_utils::format1(&b"\x19Ethereum Signed Message:\n{}", message_len)));
    vector::append(&mut result, *message);
    aptos_hash::keccak256(result)
  }

  /// Extract `signature` and `recovery_id` from `singature_bytes`
  public fun signature_and_recovery_id(bytes: &vector<u8>): (ECDSASignature, u8) {
    // get signature
    let signature = secp256k1::ecdsa_signature_from_bytes(
      extract_from_bytes(bytes, 0, 64)
    );

    // get recovery id
    let recovery_id = *vector::borrow(bytes, 64);
    if (recovery_id == 27 || recovery_id == 28) {
        recovery_id = recovery_id - 27;
    };
    // Recovery ID must be 0 or 1   
    assert!(recovery_id <= 1, ERROR_INVALID_RECOVERY_ID);

    (signature, recovery_id)
  }

  /// Recover Ethereum address from digest_bytes
  public fun secp256k1_recover_ethereum_address(
    digest_bytes: &vector<u8>,
    signature_bytes: &vector<u8>
  ): Option<vector<u8>> {
    let (signature, recovery_id) = signature_and_recovery_id(signature_bytes);
    let public_key: Option<ECDSARawPublicKey> = secp256k1::ecdsa_recover(
      *digest_bytes,
      recovery_id,
      &signature
    );

    if (option::is_some(&public_key)) {
      option::some(ethereum_address_from_pubkey(option::borrow(&public_key)))
    } else {
      option::none()
    }
  }

  // extract ethereum address from pubkey
  fun ethereum_address_from_pubkey(pubkey: &ECDSARawPublicKey): vector<u8> {
    let pubkey_bytes: vector<u8> = secp256k1::ecdsa_raw_public_key_to_bytes(pubkey);
    extract_from_bytes(&aptos_hash::keccak256(pubkey_bytes), 12, 0)
  }

  #[test]
  fun extract_test() {
    let v1 = vector[2, 5, 2, 3, 6, 9, 3, 1, 7];
    assert!(extract_from_bytes(&v1, 0, 3) == vector[2, 5, 2], 0);
    assert!(extract_from_bytes(&v1, 4, 6) == vector[6, 9], 0);
    assert!(extract_from_bytes(&v1, 6, 0) == vector[3, 1, 7], 0);
  }

  #[test]
  fun ethereum_hash_test() {
    assert!(eth_signed_message_hash(&b"gm crypto!") == x"48bff99f5a7cd927c752ed504f215208c7bde904172807518020c64e3198c558", 1);
    assert!(eth_signed_message_hash(&b"hyperlane") == x"75a903cf4aa75fc053b8f0aa13dbf83322cc022e7377ba180e4a67416fe786e1", 1);
  }

  #[test]
  fun secp256k1_recover_test() {
    // A test signature from this Ethereum address:
    //   Address: 0xfdB65576568b99A8a00a292577b8fc51abB115bD
    //   Private Key: 0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691
    //   Public Key: 0xbbcf76b2fea8b0a55fa498fd6feb92480be2652ad879d9aaa5972c5ed0683c1e4bffd6096450b9f26c649f3f94ce41c4b2a36631379ca1994a42ff275ede5569
    // The signature was generated using ethers-js:
    //   wallet = new ethers.Wallet('0x87368bfca2e509afbb87838a64a68bc34b8f7962a0496d12df6200e3401be691')
    //   await wallet.signMessage(ethers.utils.arrayify('0xf00000000000000000000000000000000000000000000000000000000000000f'))

    let signed_hash = eth_signed_message_hash(&x"f00000000000000000000000000000000000000000000000000000000000000f");
    let signature_bytes = x"4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a901";
    let eth_address = secp256k1_recover_ethereum_address(&signed_hash, &signature_bytes);
    assert!(*option::borrow(&eth_address) == x"fdB65576568b99A8a00a292577b8fc51abB115bD", 1);
  }

  #[test]
  fun compare_bytes_and_address_test() {
    let result = compare_bytes_and_address(&x"598264ff31f198f6071226b2b7e9ce360163accd", &@0x598264ff31f198f6071226b2b7e9ce360163accd);
    assert!(result, 0)
  }
}