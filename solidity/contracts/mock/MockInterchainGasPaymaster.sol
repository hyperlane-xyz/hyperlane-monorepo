// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/console.sol";

contract MockInterchainGasPaymaster {
    uint256 private gasPayment;

    function setGasPayment(uint256 _gasPayment) external {
        gasPayment = _gasPayment;
    }

    function quoteGasPayment(uint32, uint256) external view returns (uint256) {
        return gasPayment;
    }

    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) external payable {
        // do nothing
    }
}
