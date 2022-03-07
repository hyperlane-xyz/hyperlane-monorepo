// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

contract TestSet {
    uint256 private x;

    function set(uint256 _x) external {
        x = _x;
    }

    function get() external view returns (uint256) {
        return x;
    }
}
