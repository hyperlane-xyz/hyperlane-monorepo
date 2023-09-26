module hp_library::ism_metadata {
  use std::vector;
  use aptos_std::from_bcs;
  
  use hp_library::utils;

  //
  // constants
  //
  const ORIGIN_MAILBOX_OFFSET: u64 = 0;
  const MERKLE_ROOT_OFFSET: u64 = 32;
  const SIGNATURES_OFFSET: u64 = 64;
  const SIGNATURE_LENGTH: u64 = 65;

  //
  // errors
  //
  const ERROR_INVALID_BYTES_LENGTH: u64 = 1;
  const ERROR_INVALID_RECOVERY_ID: u64 = 2;

  /// Get mailbox address on origin chain from metadata bytes
  public fun origin_mailbox(metadata_bytes: &vector<u8>): address {
    from_bcs::to_address(utils::extract_from_bytes(metadata_bytes, ORIGIN_MAILBOX_OFFSET, MERKLE_ROOT_OFFSET))
  }

  /// Get merkle root from metadata bytes
  public fun merkle_root(metadata_bytes: &vector<u8>): vector<u8> {
    utils::extract_from_bytes(metadata_bytes, MERKLE_ROOT_OFFSET, SIGNATURES_OFFSET)
  }

  /// Get nth signature from metadata_bytes
  public fun signature_at(metadata_bytes: &vector<u8>, index: u64): vector<u8> {
    let bytes_len = vector::length(metadata_bytes);
    let sigbytes_len = bytes_len - SIGNATURES_OFFSET;
    assert!(sigbytes_len % SIGNATURE_LENGTH == 0, ERROR_INVALID_BYTES_LENGTH);

    let start = SIGNATURES_OFFSET + index * SIGNATURE_LENGTH;
    let end = start + SIGNATURE_LENGTH;
    
    // get signature
    utils::extract_from_bytes(metadata_bytes, start, end)
  }

}