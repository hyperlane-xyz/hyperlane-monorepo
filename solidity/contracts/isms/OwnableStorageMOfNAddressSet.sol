// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";

import {OwnableMOfNAddressSet} from "../libs/OwnableMOfNAddressSet.sol";
import {StorageMOfNAddressSet} from "../libs/StorageMOfNAddressSet.sol";

/**
 * @title OwnableStorageMOfNAddressSet
 * @dev Implements OwnableMOfNAddressSet using the StorageMOfNAddressSet library
 */
contract OwnableStorageMOfNAddressSet is OwnableMOfNAddressSet {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.UintSet;

    // ============ Private Storage ============
    EnumerableSet.UintSet private _domainsWithSets;
    mapping(uint32 => StorageMOfNAddressSet.AddressSet) private _sets;

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() OwnableMOfNAddressSet() {}

    // ============ Public Functions ============

    /**
     * @notice Returns whether an address is contained in a set.
     * @param _domain The remote domain of the set.
     * @param _value The address to test for set membership.
     * @return True if the address is contained, false otherwise.
     */
    function contains(uint32 _domain, address _value)
        public
        view
        virtual
        override
        returns (bool)
    {
        return StorageMOfNAddressSet.contains(_sets[_domain], _value);
    }

    /**
     * @notice Gets the current set
     * @param _domain The remote domain of the set.
     * @return The addresses of the set.
     */
    function values(uint32 _domain)
        public
        view
        virtual
        override
        returns (address[] memory)
    {
        return StorageMOfNAddressSet.values(_sets[_domain]);
    }

    /**
     * @notice Gets the current threshold
     * @param _domain The remote domain of the set.
     * @return The threshold of the set.
     */
    function threshold(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint8)
    {
        return StorageMOfNAddressSet.threshold(_sets[_domain]);
    }

    /**
     * @notice Returns the number of values contained in the set.
     * @param _domain The remote domain of the set.
     * @return The number of values contained in the set.
     */
    function length(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return StorageMOfNAddressSet.length(_sets[_domain]);
    }

    /**
     * @notice Returns the array of domains that have non-empty sets
     * @return The array of domains that have non-empty sets
     */
    function domains() public view virtual override returns (uint32[] memory) {
        uint256[] memory _uint256Domains = _domainsWithSets.values();
        uint32[] memory _uint32Domains = new uint32[](_uint256Domains.length);
        for (uint256 i = 0; i < _uint256Domains.length; i++) {
            _uint32Domains[i] = uint32(_uint256Domains[i]);
        }
        return _uint32Domains;
    }

    // ============ Private Functions ============

    /**
     * @notice Returns the set of N addresses associated with _message
     * and the corresponding threshold M
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return values The array of addresses of length N
     * @return threshold The threshold M
     */
    function valuesAndThreshold(bytes calldata _message)
        internal
        view
        returns (address[] memory, uint8)
    {
        return valuesAndThreshold(Message.origin(_message));
    }

    /**
     * @notice Adds multiple values to multiple sets.
     * @dev Reverts if `_value` is already in the set.
     * @dev _values[i] are the values to add for _domains[i].
     * @param _domains The remote domains of the sets.
     * @param _values The values to add to the sets.
     */
    function _addMany(uint32[] calldata _domains, address[][] calldata _values)
        internal
        virtual
        override
    {
        for (uint256 i = 0; i < _domains.length; i++) {
            StorageMOfNAddressSet.add(_sets[_domains[i]], _values[i]);
        }
    }

    /**
     * @notice Adds a value into a set.
     * @dev Reverts if `_value` is already in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to add to the set.
     */
    function _add(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.add(_sets[_domain], _value);
    }

    /**
     * @notice Removes a value from a set.
     * @dev Reverts if `_value` is not in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to remove from the set.
     */
    function _remove(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.remove(_sets[_domain], _value);
    }

    /**
     * @notice Sets the threshold M.
     * @param _domain The remote domain of the set.
     * @param _threshold The new threshold.
     */
    function _setThreshold(uint32 _domain, uint8 _threshold)
        internal
        virtual
        override
    {
        StorageMOfNAddressSet.setThreshold(_sets[_domain], _threshold);
    }

    /**
     * @notice Adds domain to the list of domains
     * @param _domain The domain to add
     */
    function _addDomain(uint32 _domain) internal virtual override {
        _domainsWithSets.add(_domain);
    }

    /**
     * @notice Removes the set for _domain
     * @param _domain The domain to remove the set for
     */
    function _removeDomain(uint32 _domain) internal virtual override {
        require(_domainsWithSets.remove(_domain), "unable to remove domain");
        StorageMOfNAddressSet.clear(_sets[_domain]);
    }
}
