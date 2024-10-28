pub mod merkleroot_ism_metadata {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};

    pub trait MerkleRootIsmMetadata {
        fn origin_merkle_tree_hook(_metadata: Bytes) -> u256;
        fn message_index(_metadata: Bytes) -> u32;
        fn signed_index(_metadata: Bytes) -> u32;
        fn signed_message_id(_metadata: Bytes) -> u256;
        fn proof(_metadata: Bytes) -> Span<u256>;
        fn signature_at(_metadata: Bytes, _index: u32) -> (u8, u256, u256);
    }

    ///
    /// * Format of metadata:
    /// * [   0:  32] Origin merkle tree address
    /// * [  32:  36] Index of message ID in merkle tree
    /// * [  36:  68] Signed checkpoint message ID
    /// * [  68:1092] Merkle proof
    /// * [1092:1096] Signed checkpoint index (computed from proof and index)
    /// * [1096:????] Validator signatures (length := threshold * 65)
    /// 
    pub const ORIGIN_MERKLE_TREE_OFFSET: u32 = 0;
    pub const MESSAGE_INDEX_OFFSET: u32 = 32;
    pub const MESSAGE_ID_OFFSET: u32 = 36;
    pub const MERKLE_PROOF_OFFSET: u32 = 68;
    pub const MERKLE_PROOF_ITERATION: u32 = 32;
    pub const MERKLE_PROOF_SIZE: u32 = 32;
    pub const MERKLE_PROOF_LENGTH: u32 = MERKLE_PROOF_SIZE * MERKLE_PROOF_ITERATION;
    pub const SIGNED_INDEX_OFFSET: u32 = 1092;
    pub const SIGNATURES_OFFSET: u32 = 1096;
    pub const SIGNATURE_LENGTH: u32 = 65;
    impl MerkleRootIsmMetadataImpl of MerkleRootIsmMetadata {
        /// Returns the origin merkle tree hook of the signed checkpoint 
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// 
        /// # Returns
        /// 
        /// u256 -   Origin merkle tree hook of the signed checkpoint 
        fn origin_merkle_tree_hook(_metadata: Bytes) -> u256 {
            let (_, felt) = _metadata.read_u256(ORIGIN_MERKLE_TREE_OFFSET);
            felt
        }

        /// Returns the index of the message being proven.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// 
        /// # Returns
        /// 
        /// u32 -   Index of the target message in the merkle tree.
        fn message_index(_metadata: Bytes) -> u32 {
            let (_, felt) = _metadata.read_u32(MESSAGE_INDEX_OFFSET);
            felt
        }

        /// Returns the index of the signed checkpoint.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// 
        /// # Returns
        /// 
        /// u32 -   Index of the signed checkpoint
        fn signed_index(_metadata: Bytes) -> u32 {
            let (_, felt) = _metadata.read_u32(SIGNED_INDEX_OFFSET);
            felt
        }
        /// Returns the message ID of the signed checkpoint.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// 
        /// # Returns
        /// 
        /// u256 -   Message ID of the signed checkpoint
        fn signed_message_id(_metadata: Bytes) -> u256 {
            let (_, felt) = _metadata.read_u256(MESSAGE_ID_OFFSET);
            felt
        }
        /// Returns the merkle proof branch of the message.
        /// 
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// 
        /// # Returns
        /// 
        /// Span<u256> -  Merkle proof branch of the message.
        fn proof(_metadata: Bytes) -> Span<u256> {
            let mut bytes_arr = array![];
            let mut cur_idx = 0;
            loop {
                if (cur_idx == MERKLE_PROOF_ITERATION) {
                    break ();
                }
                let (_, res) = _metadata
                    .read_u256(MERKLE_PROOF_OFFSET + cur_idx * MERKLE_PROOF_SIZE);
                bytes_arr.append(res);
                cur_idx += 1;
            };
            bytes_arr.span()
        }
        /// Returns the validator ECDSA signature at `_index`.
        /// Dev: Assumes signatures are sorted by validator
        /// Dev: Assumes `_metadata` encodes `threshold` signatures.
        /// Dev: Assumes `_index` is less than `threshold`
        /// # Arguments
        ///
        /// * - `_metadata` - encoded multisig ISM metadata
        /// * - `_index` - The index of the signature to return.
        /// 
        /// # Returns
        /// 
        /// (u8, u256, u256) -  The validator ECDSA signature at `_index`.
        fn signature_at(_metadata: Bytes, _index: u32) -> (u8, u256, u256) {
            // the first signer index is 0
            let (index_r, r) = _metadata.read_u256(SIGNATURES_OFFSET + SIGNATURE_LENGTH * _index);
            let (index_s, s) = _metadata.read_u256(index_r);
            let (_, v) = _metadata.read_u8(index_s);
            (v, r, s)
        }
    }
}
