// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Router.sol";

contract TestRouter is Router {
    event InitializeOverload();

    function initialize(address _mailbox, address _interchainGasPaymaster)
        external
        initializer
    {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster
        );
        emit InitializeOverload();
    }

    function _handle(
        uint32,
        bytes32,
        bytes calldata
    ) internal pure override {}

    function isRemoteRouter(uint32 _domain, bytes32 _potentialRemoteRouter)
        external
        view
        returns (bool)
    {
        return _isRemoteRouter(_domain, _potentialRemoteRouter);
    }

    function mustHaveRemoteRouter(uint32 _domain)
        external
        view
        returns (bytes32)
    {
        return _mustHaveRemoteRouter(_domain);
    }

    function dispatch(uint32 _destination, bytes memory _msg) external {
        _dispatch(_destination, _msg);
    }

    function dispatchWithGas(
        uint32 _destinationDomain,
        bytes memory _messageBody,
        uint256 _gasAmount,
        uint256 _gasPayment,
        address _gasPaymentRefundAddress
    ) external payable {
        _dispatchWithGas(
            _destinationDomain,
            _messageBody,
            _gasAmount,
            _gasPayment,
            _gasPaymentRefundAddress
        );
    }
}
