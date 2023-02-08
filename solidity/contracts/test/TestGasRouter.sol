// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "./TestRouter.sol";
import "../GasRouter.sol";

contract TestGasRouter is TestRouter, GasRouter {
    function dispatchWithGas(
        uint32 _destinationDomain,
        bytes memory _messageBody,
        uint256 _gasPayment,
        address _gasPaymentRefundAddress
    ) external payable {
        _dispatchWithGas(
            _destinationDomain,
            _messageBody,
            _gasPayment,
            _gasPaymentRefundAddress
        );
    }

    function dispatchWithGas(
        uint32 _destinationDomain,
        bytes memory _messageBody
    ) external payable {
        _dispatchWithGas(_destinationDomain, _messageBody);
    }
}
