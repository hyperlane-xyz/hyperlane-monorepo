// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {IEnumerableDomains} from "../interfaces/IEnumerableDomains.sol";

/**
 * @title EnumerableDomainSet
 * @notice Abstract contract that provides enumerable domain key tracking using EIP-7201 namespaced storage.
 * @dev This allows contracts to track domain keys in a separate storage slot that doesn't conflict with
 *      existing storage layouts, making it safe for upgradeable contracts.
 *
 *      Inheriting contracts must:
 *      1. Call `_addDomain(domain)` when setting domain configurations
 *      2. Call `_removeDomain(domain)` when clearing domain configurations (optional)
 *
 *      Migration for existing deployments:
 *      Since `_addDomain` is idempotent (EnumerableSet.add returns false if already present),
 *      existing deployments can populate the domain set by re-calling the existing setter
 *      functions (e.g., setDestinationGasConfigs, setRemoteGasData, setHook) with the same values.
 *
 *      The storage slot is computed using EIP-7201:
 *      keccak256(abi.encode(uint256(keccak256("hyperlane.storage.EnumerableDomainSet")) - 1)) & ~bytes32(uint256(0xff))
 */
abstract contract EnumerableDomainSet is IEnumerableDomains {
    using EnumerableSet for EnumerableSet.UintSet;

    /// @custom:storage-location erc7201:hyperlane.storage.EnumerableDomainSet
    struct DomainSetStorage {
        EnumerableSet.UintSet keys;
    }

    // keccak256(abi.encode(uint256(keccak256("hyperlane.storage.EnumerableDomainSet")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant DOMAIN_SET_STORAGE_LOCATION =
        0x401ab19a9fb8dc7fa26ffcc89668c40f221f16a983a5a473a4f0c5e49ab97b00;

    function _getDomainSetStorage()
        private
        pure
        returns (DomainSetStorage storage $)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            $.slot := DOMAIN_SET_STORAGE_LOCATION
        }
    }

    // ============ External Functions ============

    /**
     * @notice Returns all configured domains.
     * @return An array of domain IDs.
     */
    function domains() external view returns (uint32[] memory) {
        return _getDomains();
    }

    // ============ Internal Functions ============

    /**
     * @notice Returns all configured domains.
     * @return result An array of domain IDs.
     */
    function _getDomains() internal view returns (uint32[] memory result) {
        DomainSetStorage storage $ = _getDomainSetStorage();
        uint256 length = $.keys.length();
        result = new uint32[](length);
        for (uint256 i = 0; i < length; i++) {
            result[i] = uint32($.keys.at(i));
        }
    }

    /**
     * @notice Adds a domain to the enumerable set.
     * @param _domain The domain ID to add.
     * @return True if the domain was added, false if it already existed.
     */
    function _addDomain(uint32 _domain) internal returns (bool) {
        return _getDomainSetStorage().keys.add(uint256(_domain));
    }

    /**
     * @notice Removes a domain from the enumerable set.
     * @param _domain The domain ID to remove.
     * @return True if the domain was removed, false if it didn't exist.
     */
    function _removeDomain(uint32 _domain) internal returns (bool) {
        return _getDomainSetStorage().keys.remove(uint256(_domain));
    }

    /**
     * @notice Checks if a domain exists in the enumerable set.
     * @param _domain The domain ID to check.
     * @return True if the domain exists, false otherwise.
     */
    function _containsDomain(uint32 _domain) internal view returns (bool) {
        return _getDomainSetStorage().keys.contains(uint256(_domain));
    }

    /**
     * @notice Returns the number of domains in the set.
     * @return The count of domains.
     */
    function _domainCount() internal view returns (uint256) {
        return _getDomainSetStorage().keys.length();
    }
}
