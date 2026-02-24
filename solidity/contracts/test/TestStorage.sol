// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title TestStorage
 * @notice Simple storage contract for integration testing
 */
contract TestStorage {
    uint256 public value;
    address public owner;

    event ValueSet(uint256 indexed oldValue, uint256 indexed newValue);

    constructor(uint256 _initialValue, address _owner) {
        value = _initialValue;
        owner = _owner;
    }

    function set(uint256 _value) external {
        uint256 oldValue = value;
        value = _value;
        emit ValueSet(oldValue, _value);
    }

    function get() external view returns (uint256) {
        return value;
    }
}
