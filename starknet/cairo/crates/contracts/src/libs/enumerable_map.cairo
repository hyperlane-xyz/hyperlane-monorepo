use core::hash::{HashStateTrait};
use core::num::traits::Zero;
use core::pedersen::PedersenTrait;
use core::poseidon::poseidon_hash_span;
use starknet::storage_access::{
    StorageBaseAddress, storage_address_from_base, storage_base_address_from_felt252
};
use starknet::{Store, SyscallResultTrait, SyscallResult};
pub mod Err {
    pub const NOT_IMPLEMENTED: felt252 = 'Not implemented!';
    pub const INDEX_OUT_OF_BOUNDS: felt252 = 'Index out of bounds!';
    pub const KEY_DOES_NOT_EXIST: felt252 = 'Key does not exist!';
}

// Enumerable map
// struct EnumerableMap {
//   values: Map<K,V>
//   keys: List<K>  
//   positions: Map<K,u32>  
// }
#[derive(Copy, Drop)]
pub struct EnumerableMap<K, V> {
    address_domain: u32,
    base: StorageBaseAddress
}

/// A storage interface for an `EnumerableMap` that allows reading and writing
/// to a system store. This trait defines how to read, write, and handle storage
/// for `EnumerableMap` structures. It also provides methods to handle reading 
/// and writing at specific offsets in storage.
///
/// # Parameters:
/// - `K`: The key type.
/// - `V`: The value type.
///
/// # Example:
/// ```rust
/// let map = EnumerableMapStore::<K, V>::read(domain, address);
/// ```
pub impl EnumerableMapStore<
    K, V, +Store<K>, +Drop<K>, +Store<V>, +Drop<V>
> of Store<EnumerableMap<K, V>> {
    /// Reads the `EnumerableMap` from storage at the given `base` address
    /// within the specified `address_domain`.
    ///
    /// # Arguments:
    /// - `address_domain`: The domain in which the map is stored.
    /// - `base`: The base storage address for the map.
    ///
    /// # Returns:
    /// - `SyscallResult<EnumerableMap<K, V>>`: The map read from storage.
    #[inline(always)]
    fn read(address_domain: u32, base: StorageBaseAddress) -> SyscallResult<EnumerableMap<K, V>> {
        SyscallResult::Ok(EnumerableMap::<K, V> { address_domain, base })
    }

    /// Attempts to write the `EnumerableMap` to storage. Currently not implemented.
    ///
    /// # Arguments:
    /// - `address_domain`: The domain in which to write the map.
    /// - `base`: The base storage address for the map.
    /// - `value`: The `EnumerableMap` to write.
    ///
    /// # Returns:
    /// - `SyscallResult<()>`: Error indicating not implemented.
    #[inline(always)]
    fn write(
        address_domain: u32, base: StorageBaseAddress, value: EnumerableMap<K, V>
    ) -> SyscallResult<()> {
        SyscallResult::Err(array![Err::NOT_IMPLEMENTED])
    }

    /// Attempts to read the `EnumerableMap` from storage at a specific offset.
    ///
    /// # Arguments:
    /// - `address_domain`: The domain in which the map is stored.
    /// - `base`: The base storage address for the map.
    /// - `offset`: The offset in storage where the map is read from.
    ///
    /// # Returns:
    /// - `SyscallResult<EnumerableMap<K, V>>`: Error indicating not implemented.
    #[inline(always)]
    fn read_at_offset(
        address_domain: u32, base: StorageBaseAddress, offset: u8
    ) -> SyscallResult<EnumerableMap<K, V>> {
        SyscallResult::Err(array![Err::NOT_IMPLEMENTED])
    }


    /// Attempts to write the `EnumerableMap` to storage at a specific offset.
    ///
    /// # Arguments:
    /// - `address_domain`: The domain in which to write the map.
    /// - `base`: The base storage address for the map.
    /// - `offset`: The offset in storage where the map is written to.
    /// - `value`: The `EnumerableMap` to write.
    ///
    /// # Returns:
    /// - `SyscallResult<()>`: Error indicating not implemented.
    #[inline(always)]
    fn write_at_offset(
        address_domain: u32, base: StorageBaseAddress, offset: u8, value: EnumerableMap<K, V>
    ) -> SyscallResult<()> {
        SyscallResult::Err(array![Err::NOT_IMPLEMENTED])
    }


    /// Returns the size of the `EnumerableMap` in bytes. Currently set to `0`.
    ///
    /// # Returns:
    /// - `u8`: The size of the map in bytes.
    #[inline(always)]
    fn size() -> u8 {
        // 0 was selected because the read method doesn't actually read from storage
        0_u8
    }
}

/// Trait defining basic operations for a key-value map where the keys are stored
/// in an enumerable way. This provides functionality to get, set, check for keys, 
/// and retrieve values.
///
/// # Parameters:
/// - `K`: The key type.
/// - `V`: The value type.
///
/// # Example:
/// ```rust
/// let value = map.get(key);
/// map.set(key, value);
/// ```
pub trait EnumerableMapTrait<K, V> {
    /// Retrieves the value associated with the specified `key`.
    ///
    /// # Arguments:
    /// - `key`: The key for which to retrieve the value.
    ///
    /// # Returns:
    /// - `V`: The value associated with the `key`
    fn get(self: @EnumerableMap<K, V>, key: K) -> V;

    /// Associates the specified `key` with the provided `val` and adds it to
    /// the map if it does not already exist.
    ///
    /// # Arguments:
    /// - `key`: The key to associate with the value.
    /// - `val`: The value to associate with the key.
    fn set(ref self: EnumerableMap<K, V>, key: K, val: V) -> ();

    /// Returns the number of key-value pairs stored in the map.
    ///
    /// # Returns:
    /// - `u32`: The number of elements in the map.
    fn len(self: @EnumerableMap<K, V>) -> u32;

    /// Checks if the map contains the specified `key`.
    ///
    /// # Arguments:
    /// - `key`: The key to check.
    ///
    /// # Returns:
    /// - `bool`: `true` if the key exists, `false` otherwise.
    fn contains(self: @EnumerableMap<K, V>, key: K) -> bool;

    /// Removes the key-value pair associated with the specified `key` from the map.
    ///
    /// # Arguments:
    /// - `key`: The key to remove.
    ///
    /// # Returns:
    /// - `bool`: `true` if the removal was successful, `false` if the key does not exist.
    fn remove(ref self: EnumerableMap<K, V>, key: K) -> bool;

    /// Retrieves the key-value pair stored at the specified `index` in the map.
    ///
    /// # Arguments:
    /// - `index`: The index at which to retrieve the key-value pair.
    ///
    /// # Returns:
    /// - `(K, V)`: The key-value pair at the specified index.
    fn at(self: @EnumerableMap<K, V>, index: u32) -> (K, V);

    /// Returns an array of all keys stored in the map.
    ///
    /// # Returns:
    /// - `Array<K>`: An array of all keys in the map.
    fn keys(self: @EnumerableMap<K, V>) -> Array<K>;
}

pub impl EnumerableMapImpl<
    K,
    V,
    +Drop<K>,
    +Drop<V>,
    +Store<K>,
    +Store<V>,
    +Copy<K>,
    +Copy<V>,
    +Zero<K>,
    +Zero<V>,
    +Serde<K>,
> of EnumerableMapTrait<K, V> {
    fn get(self: @EnumerableMap<K, V>, key: K) -> V {
        let value = EnumerableMapInternalTrait::<K, V>::values_mapping_read(self, key);
        assert(value.is_non_zero() || self.contains(key), Err::KEY_DOES_NOT_EXIST);
        value
    }

    fn set(ref self: EnumerableMap<K, V>, key: K, val: V) {
        let is_exists = self.contains(key);

        EnumerableMapInternalTrait::<K, V>::values_mapping_write(ref self, key, val);
        if !is_exists {
            // appends 'key' to array and updates 'position' mapping
            EnumerableMapInternalTrait::<K, V>::array_append(ref self, key);
        }
    }

    fn len(self: @EnumerableMap<K, V>) -> u32 {
        Store::<u32>::read(*self.address_domain, *self.base).unwrap_syscall()
    }

    fn contains(self: @EnumerableMap<K, V>, key: K) -> bool {
        EnumerableMapInternalTrait::<K, V>::positions_mapping_read(self, key) != 0
    }

    fn remove(ref self: EnumerableMap<K, V>, key: K) -> bool {
        if !self.contains(key) {
            return false;
        }
        let index = EnumerableMapInternalImpl::<K, V>::positions_mapping_read(@self, key) - 1;
        // Deletes `key` from 'values' mapping
        EnumerableMapInternalTrait::<K, V>::values_mapping_write(ref self, key, Zero::<V>::zero());
        // Deletes `key`` from 'array' and 'positions' mapping
        EnumerableMapInternalTrait::<K, V>::array_remove(ref self, index)
    }

    fn at(self: @EnumerableMap<K, V>, index: u32) -> (K, V) {
        assert(index < self.len(), Err::INDEX_OUT_OF_BOUNDS);
        let key = EnumerableMapInternalTrait::<K, V>::array_read(self, index);
        let val = EnumerableMapInternalTrait::<K, V>::values_mapping_read(self, key);
        (key, val)
    }

    fn keys(self: @EnumerableMap<K, V>) -> Array<K> {
        let mut i = 0;
        let len = self.len();
        let mut keys = array![];
        while i < len {
            let key = EnumerableMapInternalTrait::<K, V>::array_read(self, i);
            keys.append(key);
            i += 1;
        };
        keys
    }
}

/// Internal trait for managing the internal structures of an `EnumerableMap`.
/// This trait handles reading and writing key-value pairs and their positions, 
/// as well as managing the array of keys for enumeration.
///
/// # Parameters:
/// - `K`: The key type.
/// - `V`: The value type.
///
/// # Example:
/// ```rust
/// EnumerableMapInternalTrait::<K, V>::values_mapping_write(map, key, value);
/// ```
trait EnumerableMapInternalTrait<K, V> {
    /// Writes the specified `val` associated with the `key` into the `values` mapping.
    ///
    /// # Arguments:
    /// - `key`: The key to associate with the value.
    /// - `val`: The value to store.
    fn values_mapping_write(ref self: EnumerableMap<K, V>, key: K, val: V);

    /// Reads the value associated with the `key` from the `values` mapping.
    ///
    /// # Arguments:
    /// - `key`: The key for which to read the value.
    ///
    /// # Returns:
    /// - `V`: The value associated with the `key`.
    fn values_mapping_read(self: @EnumerableMap<K, V>, key: K) -> V;

    /// Writes the position of the `key` in the `positions` mapping.
    ///
    /// # Arguments:
    /// - `key`: The key for which to store the position.
    /// - `val`: The position to store.
    fn positions_mapping_write(ref self: EnumerableMap<K, V>, key: K, val: u32);

    /// Reads the position of the `key` from the `positions` mapping.
    ///
    /// # Arguments:
    /// - `key`: The key for which to retrieve the position.
    ///
    /// # Returns:
    /// - `u32`: The position associated with the `key`.
    fn positions_mapping_read(self: @EnumerableMap<K, V>, key: K) -> u32;

    /// Updates the length of the key array in storage.
    ///
    /// # Arguments:
    /// - `new_len`: The new length of the array.
    fn update_array_len(ref self: EnumerableMap<K, V>, new_len: u32);

    /// Appends the `key` to the array of keys.
    ///
    /// # Arguments:
    /// - `key`: The key to append to the array.
    fn array_append(ref self: EnumerableMap<K, V>, key: K);

    /// Removes the key-value pair at the specified `index` from the array.
    ///
    /// # Arguments:
    /// - `index`: The index of the key-value pair to remove.
    ///
    /// # Returns:
    /// - `bool`: `true` if the removal was successful, `false` otherwise.
    fn array_remove(ref self: EnumerableMap<K, V>, index: u32) -> bool;

    /// Reads the key at the specified `index` from the array of keys.
    ///
    /// # Arguments:
    /// - `index`: The index at which to read the key.
    ///
    /// # Returns:
    /// - `K`: The key at the specified index.
    fn array_read(self: @EnumerableMap<K, V>, index: u32) -> K;

    /// Writes the specified `key` at the given `index` in the array of keys.
    ///
    /// # Arguments:
    /// - `index`: The index at which to write the key.
    /// - `val`: The key to write.
    fn array_write(ref self: EnumerableMap<K, V>, index: u32, val: K);
}


impl EnumerableMapInternalImpl<
    K,
    V,
    +Drop<K>,
    +Drop<V>,
    +Store<K>,
    +Store<V>,
    +Copy<K>,
    +Copy<V>,
    +Zero<K>,
    +Zero<V>,
    +Serde<K>,
> of EnumerableMapInternalTrait<K, V> {
    fn values_mapping_write(ref self: EnumerableMap<K, V>, key: K, val: V) {
        let storage_base_felt: felt252 = storage_address_from_base(self.base).into();
        let mut storage_address_val = PedersenTrait::new(storage_base_felt).update('values');
        let mut serialized_key: Array<felt252> = array![];
        key.serialize(ref serialized_key);
        let mut i = 0;
        let len = serialized_key.len();
        while i < len {
            storage_address_val = storage_address_val.update(*serialized_key.at(i));
            i += 1;
        };
        let storage_address_val_felt = storage_address_val.finalize();
        Store::<
            V
        >::write(
            self.address_domain, storage_base_address_from_felt252(storage_address_val_felt), val
        )
            .unwrap_syscall();
    }

    fn values_mapping_read(self: @EnumerableMap<K, V>, key: K) -> V {
        let storage_base_felt: felt252 = storage_address_from_base(*self.base).into();
        let mut storage_address_val = PedersenTrait::new(storage_base_felt).update('values');
        let mut serialized_key: Array<felt252> = array![];
        key.serialize(ref serialized_key);
        let mut i = 0;
        let len = serialized_key.len();
        while i < len {
            storage_address_val = storage_address_val.update(*serialized_key.at(i));
            i += 1;
        };
        let storage_address_val_felt = storage_address_val.finalize();
        Store::<
            V
        >::read(*self.address_domain, storage_base_address_from_felt252(storage_address_val_felt))
            .unwrap_syscall()
    }

    fn positions_mapping_write(ref self: EnumerableMap<K, V>, key: K, val: u32) {
        let storage_base_felt: felt252 = storage_address_from_base(self.base).into();
        let mut storage_address_val = PedersenTrait::new(storage_base_felt).update('positions');
        let mut serialized_key: Array<felt252> = array![];
        key.serialize(ref serialized_key);
        let mut i = 0;
        let len = serialized_key.len();
        while i < len {
            storage_address_val = storage_address_val.update(*serialized_key.at(i));
            i += 1;
        };
        let storage_address_val_felt = storage_address_val.finalize();
        Store::<
            u32
        >::write(
            self.address_domain, storage_base_address_from_felt252(storage_address_val_felt), val
        )
            .unwrap_syscall();
    }

    fn positions_mapping_read(self: @EnumerableMap<K, V>, key: K) -> u32 {
        let storage_base_felt: felt252 = storage_address_from_base(*self.base).into();
        let mut storage_address_val = PedersenTrait::new(storage_base_felt).update('positions');
        let mut serialized_key: Array<felt252> = array![];
        key.serialize(ref serialized_key);
        let mut i = 0;
        let len = serialized_key.len();
        while i < len {
            storage_address_val = storage_address_val.update(*serialized_key.at(i));
            i += 1;
        };
        let storage_address_val_felt = storage_address_val.finalize();
        Store::<
            u32
        >::read(*self.address_domain, storage_base_address_from_felt252(storage_address_val_felt))
            .unwrap_syscall()
    }

    fn update_array_len(ref self: EnumerableMap<K, V>, new_len: u32) {
        Store::<u32>::write(self.address_domain, self.base, new_len).unwrap_syscall();
    }

    fn array_append(ref self: EnumerableMap<K, V>, key: K) {
        let len = Store::<u32>::read(self.address_domain, self.base).unwrap_syscall();
        self.array_write(len, key);
        self.update_array_len(len + 1);
        self.positions_mapping_write(key, len + 1);
    }

    fn array_remove(ref self: EnumerableMap<K, V>, index: u32) -> bool {
        let len = Store::<u32>::read(self.address_domain, self.base).unwrap_syscall();
        if index >= len {
            return false;
        }
        let element = self.array_read(index);
        // Remove `element` from `positions` mapping
        self.positions_mapping_write(element, 0);
        // if element is not the last element, swap with last element and clear the last index
        if index != len - 1 {
            let last_element = self.array_read(len - 1);
            // Updates the position of `last_element` in 'positions' mapping
            self.positions_mapping_write(last_element, index + 1);
            // Moves last element into 'index' and remove the last element
            self.array_write(index, last_element);
            // Deletes the last element from array
            self.array_write(len - 1, Zero::<K>::zero());
        }
        // Decrease the array length
        self.update_array_len(len - 1);
        true
    }

    fn array_read(self: @EnumerableMap<K, V>, index: u32) -> K {
        let storage_base_felt: felt252 = storage_address_from_base(*self.base).into();
        let storage_address_felt = poseidon_hash_span(
            array![storage_base_felt, index.into()].span()
        );
        Store::<
            K
        >::read(*self.address_domain, storage_base_address_from_felt252(storage_address_felt))
            .unwrap_syscall()
    }

    fn array_write(ref self: EnumerableMap<K, V>, index: u32, val: K) {
        let storage_base_felt: felt252 = storage_address_from_base(self.base).into();
        let storage_address_felt = poseidon_hash_span(
            array![storage_base_felt, index.into()].span()
        );
        Store::<
            K
        >::write(self.address_domain, storage_base_address_from_felt252(storage_address_felt), val)
            .unwrap_syscall();
    }
}
