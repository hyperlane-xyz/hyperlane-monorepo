pub mod checkpoint_lib {
    use alexandria_bytes::{Bytes, BytesTrait, BytesStore};
    use contracts::libs::message::Message;
    use contracts::utils::keccak256::{
        reverse_endianness, compute_keccak, ByteData, u64_word_size, u256_word_size, HASH_SIZE,
        to_eth_signature
    };


    pub trait CheckpointLib {
        fn digest(
            _origin: u32,
            _origin_merkle_tree_hook: u256,
            _checkpoint_root: u256,
            _checkpoint_index: u32,
            _message_id: u256
        ) -> u256;
        fn domain_hash(_origin: u32, _origin_merkle_tree_hook: u256) -> u256;
    }
    const HYPERLANE: felt252 = 'HYPERLANE';
    pub const HYPERLANE_ANNOUNCEMENT: felt252 = 'HYPERLANE_ANNOUNCEMENT';

    impl CheckpointLibImpl of CheckpointLib {
        /// Returns the digest validators are expected to sign when signing checkpoints.
        /// 
        /// # Arguments
        /// 
        /// * - `_origin` - The origin domain of the checkpoint.
        /// * - `_origin_merkle_tree_hook` - The address of the origin merkle tree hook 
        /// * - `_checkpoint_root` -  The root of the checkpoint.
        /// * - `_checkpoint_index` - The index of the checkpoint.
        /// * - `_message_id` - The message ID of the checkpoint.
        /// 
        /// # Returns 
        /// 
        /// u256 - the digest 
        fn digest(
            _origin: u32,
            _origin_merkle_tree_hook: u256,
            _checkpoint_root: u256,
            _checkpoint_index: u32,
            _message_id: u256
        ) -> u256 {
            let domain_hash = CheckpointLibImpl::domain_hash(_origin, _origin_merkle_tree_hook);
            let mut input: Array<ByteData> = array![
                ByteData { value: domain_hash.into(), size: HASH_SIZE },
                ByteData { value: _checkpoint_root.into(), size: 32 },
                ByteData { value: _checkpoint_index.into(), size: 4 },
                ByteData { value: _message_id.into(), size: HASH_SIZE },
            ];
            to_eth_signature(reverse_endianness(compute_keccak(input.span())))
        }

        /// Returns the domain hash validators are expected to use when signing checkpoints.
        /// 
        /// # Arguments
        /// 
        /// * - `_origin` - The origin domain of the checkpoint.
        /// * - `_origin_merkle_tree_hook` - The address of the origin merkle tree hook 
        /// 
        /// # Returns 
        /// 
        /// u256 -  The domain hash.
        fn domain_hash(_origin: u32, _origin_merkle_tree_hook: u256) -> u256 {
            let mut input: Array<ByteData> = array![
                ByteData { value: _origin.into(), size: 4 },
                ByteData { value: _origin_merkle_tree_hook.into(), size: 32 },
                ByteData { value: HYPERLANE.into(), size: 9 }
            ];
            reverse_endianness(compute_keccak(input.span()))
        }
    }
}

