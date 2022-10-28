// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

contract MockToken {
    bool transferFromReturnValue;

    constructor() {
        transferFromReturnValue = true;
    }

    function transferFrom(
        address,
        address,
        uint256
    ) external view returns (bool) {
        return transferFromReturnValue;
    }

    function setTransferFromReturnValue(bool _returnValue) external {
        transferFromReturnValue = _returnValue;
    }
}
