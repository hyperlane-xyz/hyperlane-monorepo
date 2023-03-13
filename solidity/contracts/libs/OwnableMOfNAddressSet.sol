// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {IMOfNAddressSet} from "../../interfaces/IMOfNAddressSet.sol";
import {Message} from "./Message.sol";

// TODO: Add domains(), ability to remove domain.
abstract contract OwnableMOfNAddressSet is IMOfNAddressSet, Ownable {
    // ============ Libraries ============

    using Message for bytes;

    /**
     * @notice Emitted when a value is added to a set.
     * @param domain The remote domain of the set.
     * @param value The address of the value.
     * @param length The number of values in the set.
     */
    event ValueAdded(
        uint32 indexed domain,
        address indexed value,
        uint256 length
    );

    /**
     * @notice Emitted when a value is removed from a set.
     * @param domain The remote domain of the set.
     * @param value The address of the value.
     * @param length The number of values in the set.
     */
    event ValueRemoved(
        uint32 indexed domain,
        address indexed value,
        uint256 length
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param domain The remote domain of the set.
     * @param threshold The new quorum threshold.
     */
    event ThresholdSet(uint32 indexed domain, uint8 threshold);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Adds multiple values to multiple sets.
     * @dev Reverts if `_value` is already in the set.
     * @dev _values[i] are the values to add for _domains[i].
     * @param _domains The remote domains of the sets.
     * @param _values The values to add to the sets.
     */
    function addMany(uint32[] calldata _domains, address[][] calldata _values)
        external
        onlyOwner
    {
        require(_domains.length == _values.length, "!length");
        _addMany(_domains, _values);
        for (uint256 i = 0; i < _domains.length; i += 1) {
            uint32 _domain = _domains[i];
            uint256 _startLength = length(_domain);
            for (uint256 j = 0; j < _values[i].length; j += 1) {
                emit ValueAdded(_domain, _values[i][j], _startLength + j + 1);
            }
        }
    }

    /**
     * @notice Adds a value into a set.
     * @dev Reverts if `_value` is already in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to add to the set.
     */
    function add(uint32 _domain, address _value) external onlyOwner {
        _add(_domain, _value);
        emit ValueAdded(_domain, _value, length(_domain));
    }

    /**
     * @notice Removes a value from a set.
     * @dev Reverts if `_value` is not in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to remove from the set.
     */
    function remove(uint32 _domain, address _value) external onlyOwner {
        _remove(_domain, _value);
        emit ValueRemoved(_domain, _value, length(_domain));
    }

    /**
     * @notice Sets the quorum threshold for multiple domains.
     * @param _domains The remote domains of the sets.
     * @param _thresholds The new quorum thresholds.
     */
    function setThresholds(
        uint32[] calldata _domains,
        uint8[] calldata _thresholds
    ) external onlyOwner {
        require(_domains.length == _thresholds.length, "!length");
        for (uint256 i = 0; i < _domains.length; i += 1) {
            setThreshold(_domains[i], _thresholds[i]);
        }
    }

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
        returns (bool);

    // ============ Public Functions ============

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the set.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint32 _domain, uint8 _threshold) public onlyOwner {
        _setThreshold(_domain, _threshold);
        emit ThresholdSet(_domain, _threshold);
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
        returns (address[] memory);

    /**
     * @notice Gets the current threshold
     * @param _domain The remote domain of the set.
     * @return The threshold of the set.
     */
    function threshold(uint32 _domain) public view virtual returns (uint8);

    /**
     * @notice Returns the number of values contained in the set.
     * @param _domain The remote domain of the set.
     * @return The number of values contained in the set.
     */
    function length(uint32 _domain) public view virtual returns (uint256);

    function valuesAndThreshold(uint32 _domain)
        public
        view
        returns (address[] memory, uint8)
    {
        return (values(_domain), threshold(_domain));
    }

    // ============ Private Functions ============

    /**
     * @notice Adds multiple values to multiple sets.
     * @dev Reverts if `_value` is already in the set.
     * @dev _values[i] are the values to add for _domains[i].
     * @param _domains The remote domains of the sets.
     * @param _values The values to add to the sets.
     */
    function _addMany(uint32[] calldata _domains, address[][] calldata _values)
        internal
        virtual;

    /**
     * @notice Adds a value into a set.
     * @dev Reverts if `_value` is already in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to add to the set.
     */
    function _add(uint32 _domain, address _value) internal virtual;

    /**
     * @notice Removes a value from a set.
     * @dev Reverts if `_value` is not in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to remove from the set.
     */
    function _remove(uint32 _domain, address _value) internal virtual;

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the set.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint32 _domain, uint8 _threshold) internal virtual;
}
