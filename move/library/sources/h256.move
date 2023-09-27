module hp_library::h256 {
  
  use std::vector;
  use hp_library::utils;

  // Error
  const ERROR_EXCEED_LENGTH: u64 = 1;

  // Constant
  const DEFAULT_LENGTH: u64 = 32;
  const ZERO_32_BYTES: vector<u8> = vector[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

  /// 32-byte resource
  struct H256 has store, drop {
    inner: vector<u8>
  }

  public fun from_bytes(x: &vector<u8>): H256 {
    let xlen = vector::length(x);
    
    let inner: vector<u8> = if (xlen < DEFAULT_LENGTH) {
      // extend x to 32-bytes format
      let prefix = utils::extract_from_bytes(&ZERO_32_BYTES, 0, DEFAULT_LENGTH - xlen);
      vector::append(&mut prefix, *x);
      prefix
    } else if (xlen > DEFAULT_LENGTH) {
      // cut vector length
      utils::extract_from_bytes(x, 0, DEFAULT_LENGTH)
    } else {
      // return x itself
      *x
    };

    H256 { inner }
  }

  public fun to_bytes(x: &H256): vector<u8> {
    x.inner
  }

  #[test]
  fun test_from_bytes() {
    assert!(from_bytes(&x"8a9f9818b6ba031c5f2c8baf850942d4c98fa2ee") 
      == H256 { inner: x"0000000000000000000000008a9f9818b6ba031c5f2c8baf850942d4c98fa2ee" }, 0);

    assert!(to_bytes(&from_bytes(&x"0000008a9f9818b6ba031c5f2c8baf850942d4c98fa2ee")) 
      == x"0000000000000000000000008a9f9818b6ba031c5f2c8baf850942d4c98fa2ee", 0);

    assert!(from_bytes(&x"cc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b") 
      == H256 { inner: x"cc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b" }, 0);

    assert!(from_bytes(&x"cc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b00000000") 
      == H256 { inner: x"cc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b" }, 0);
  }
}