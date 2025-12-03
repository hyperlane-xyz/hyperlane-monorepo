// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

contract MockSafe {
    address[] private owners;
    uint256 private threshold;

    constructor(address[] memory _owners, uint256 _threshold) {
        owners = _owners;
        threshold = _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }
}
