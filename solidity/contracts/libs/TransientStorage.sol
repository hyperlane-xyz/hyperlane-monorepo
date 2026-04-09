// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.24;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

/// @notice Typed wrappers around tstore/tload opcodes for compatibility with
///         compiler versions that lack the `transient` keyword (< 0.8.28).
///         Tron TVM supports the opcodes but tron-solc lacks the keyword.
library TransientStorage {
    // ============ Store ============

    function store(bytes32 slot, uint256 val) internal {
        assembly {
            tstore(slot, val)
        }
    }

    function store(bytes32 slot, address val) internal {
        assembly {
            tstore(slot, val)
        }
    }

    function store(bytes32 slot, bytes32 val) internal {
        assembly {
            tstore(slot, val)
        }
    }

    // ============ Flag ============

    function set(bytes32 slot) internal {
        assembly {
            tstore(slot, 1)
        }
    }

    function clear(bytes32 slot) internal {
        assembly {
            tstore(slot, 0)
        }
    }

    // ============ Load ============

    function loadUint256(bytes32 slot) internal view returns (uint256 val) {
        assembly {
            val := tload(slot)
        }
    }

    function loadBool(bytes32 slot) internal view returns (bool) {
        return loadUint256(slot) != 0;
    }

    function loadAddress(bytes32 slot) internal view returns (address) {
        return address(uint160(loadUint256(slot)));
    }

    function loadBytes32(bytes32 slot) internal view returns (bytes32) {
        return bytes32(loadUint256(slot));
    }

    function loadUint128(bytes32 slot) internal view returns (uint128) {
        return uint128(loadUint256(slot));
    }

    function loadUint32(bytes32 slot) internal view returns (uint32) {
        return uint32(loadUint256(slot));
    }
}
