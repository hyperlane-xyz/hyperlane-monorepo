// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Router.sol";

contract TestRouter is Router {
    event InitializeOverload();

    function initialize(address _mailbox) external initializer {
        __Router_initialize(_mailbox);
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
        uint32 _destination,
        bytes memory _msg,
        uint256 _gasPayment
    ) external payable {
        _dispatchWithGas(_destination, _msg, _gasPayment);
    }
}
