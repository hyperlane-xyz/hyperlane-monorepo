// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

/**
 * @notice Maintains a one-to-one mapping between uint32 keys and uint16 or
 * uint32 reverse keys.
 * @dev Protocol-specific validation and events belong to the caller.
 */
library ReverseMappingLib {
    error ReverseKeyCannotBeZero();
    error ReverseKeyAssignedToAnotherKey(uint32 reverseKey, uint32 existingKey);
    error KeyNotAssigned(uint32 key);

    struct ReverseEntry {
        /// @dev Needed because key zero is valid.
        bool assigned;
        uint32 key;
    }

    struct Uint32ReverseMappingStorage {
        /// @dev Reverse key zero means the key is not assigned.
        mapping(uint32 key => uint32 reverseKey) reverseKeys;
        mapping(uint32 reverseKey => ReverseEntry entry) keys;
    }

    struct Uint16ReverseMappingStorage {
        /// @dev All assignments through this wrapper fit in uint16.
        Uint32ReverseMappingStorage data;
    }

    /// @notice Assigns a pair, replacing the key's previous reverse key.
    /// @dev A reverse key cannot be assigned to two keys. The same pair is a no-op.
    function assign(
        Uint32ReverseMappingStorage storage self,
        uint32 key,
        uint32 reverseKey
    ) internal {
        if (reverseKey == 0) {
            revert ReverseKeyCannotBeZero();
        }

        uint32 existingReverseKey = self.reverseKeys[key];
        ReverseEntry memory existingKey = self.keys[reverseKey];

        if (existingKey.assigned && existingKey.key != key) {
            revert ReverseKeyAssignedToAnotherKey(reverseKey, existingKey.key);
        }

        if (existingReverseKey == reverseKey) {
            assert(existingKey.assigned);
            return;
        }

        assert(!existingKey.assigned);
        if (existingReverseKey != 0) {
            ReverseEntry memory oldEntry = self.keys[existingReverseKey];
            assert(oldEntry.assigned && oldEntry.key == key);

            delete self.keys[existingReverseKey];
        }

        self.reverseKeys[key] = reverseKey;
        self.keys[reverseKey] = ReverseEntry({assigned: true, key: key});
    }

    /// @notice Assigns a pair with a uint16 reverse key.
    function assign(
        Uint16ReverseMappingStorage storage self,
        uint32 key,
        uint16 reverseKey
    ) internal {
        assign(self.data, key, uint32(reverseKey));
    }

    /// @notice Removes both directions of a pair and returns its reverse key.
    function remove(
        Uint16ReverseMappingStorage storage self,
        uint32 key
    ) internal returns (uint16 reverseKey) {
        uint32 value = remove(self.data, key);
        assert(value <= type(uint16).max);

        return uint16(value);
    }

    /// @notice Removes both directions of a pair and returns its reverse key.
    function remove(
        Uint32ReverseMappingStorage storage self,
        uint32 key
    ) internal returns (uint32 reverseKey) {
        reverseKey = self.reverseKeys[key];
        if (reverseKey == 0) {
            revert KeyNotAssigned(key);
        }

        ReverseEntry memory entry = self.keys[reverseKey];
        assert(entry.assigned && entry.key == key);

        delete self.reverseKeys[key];
        delete self.keys[reverseKey];
    }

    /// @notice Returns zero if the key is not assigned.
    function reverseKeyOf(
        Uint16ReverseMappingStorage storage self,
        uint32 key
    ) internal view returns (uint16) {
        uint32 value = reverseKeyOf(self.data, key);
        assert(value <= type(uint16).max);

        return uint16(value);
    }

    /// @notice Returns zero if the key is not assigned.
    function reverseKeyOf(
        Uint32ReverseMappingStorage storage self,
        uint32 key
    ) internal view returns (uint32) {
        return self.reverseKeys[key];
    }

    /// @notice Returns an unassigned entry if the reverse key is not assigned.
    function keyOf(
        Uint16ReverseMappingStorage storage self,
        uint16 reverseKey
    ) internal view returns (ReverseEntry memory) {
        return keyOf(self.data, uint32(reverseKey));
    }

    /// @notice Returns an unassigned entry if the reverse key is not assigned.
    function keyOf(
        Uint32ReverseMappingStorage storage self,
        uint32 reverseKey
    ) internal view returns (ReverseEntry memory) {
        return self.keys[reverseKey];
    }
}
