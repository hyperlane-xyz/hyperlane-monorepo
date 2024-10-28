pub mod message_id_ism_metadata {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};


    pub trait MessageIdIsmMetadata {
        fn origin_merkle_tree_hook(_metadata: Bytes) -> u256;
        fn root(_metadata: Bytes) -> u256;
        fn index(_metadata: Bytes) -> u32;
        fn signature_at(_metadata: Bytes, _index: u32) -> (u8, u256, u256);
    }


    /// * Format of metadata:
    /// * [   0:  32] Origin merkle tree address
    /// * [  32:  64] Signed checkpoint root
    /// * [  64:  68] Signed checkpoint index
    /// * [  68:????] Validator signatures (length := threshold * 65)

    pub const ORIGIN_MERKLE_TREE_HOOK_OFFSET: u32 = 0;
    pub const ROOT_OFFSET: u32 = 32;
    pub const INDEX_OFFSET: u32 = 64;
    pub const SIGNATURE_OFFSET: u32 = 68;
    pub const SIGNATURE_LENGTH: u32 = 65;
    impl MessagIdIsmMetadataImpl of MessageIdIsmMetadata {
        /// Returns the origin merkle tree hook of the signed checkpoint 
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` -Encoded MultisigISM metadata
        /// 
        /// # Returns
        /// 
        /// u256 -   Origin merkle tree hook of the signed checkpoint 
        fn origin_merkle_tree_hook(_metadata: Bytes) -> u256 {
            let (_, felt) = _metadata.read_u256(ORIGIN_MERKLE_TREE_HOOK_OFFSET);
            felt
        }

        /// Returns the merkle root of the signed checkpoint.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` -Encoded MultisigISM metadata
        /// 
        /// # Returns
        /// 
        /// u256 -    Merkle root of the signed checkpoint
        fn root(_metadata: Bytes) -> u256 {
            let (_, felt) = _metadata.read_u256(ROOT_OFFSET);
            felt
        }
        /// Returns the merkle index of the signed checkpoint.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` -Encoded MultisigISM metadata
        /// 
        /// # Returns
        /// 
        /// u32 -   Merkle index of the signed checkpoint
        fn index(_metadata: Bytes) -> u32 {
            let (_, felt) = _metadata.read_u32(INDEX_OFFSET);
            felt
        }

        /// Returns the validator ECDSA signature at `_index`.
        /// Dev: Assumes signatures are sorted by validator
        /// Assumes `_metadata` encodes `threshold` signatures.
        /// Assumes `_index` is less than `threshold`
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` -Encoded MultisigISM metadata
        /// * - `_index` - The index of the signature to return.
        /// 
        /// # Returns
        /// 
        /// (u8, u256, u256) -  The validator ECDSA signature at `_index`.
        fn signature_at(_metadata: Bytes, _index: u32) -> (u8, u256, u256) {
            // signature length set to 80 because u128 padding from the v param
            let (index_r, r) = _metadata.read_u256(SIGNATURE_OFFSET + SIGNATURE_LENGTH * _index);
            let (index_s, s) = _metadata.read_u256(index_r);
            let (_, v) = _metadata.read_u8(index_s);
            (v, r, s)
        }
    }
}
