// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Router.sol";

contract TestRouter is Router {
    function initialize(address _abacusConnectionManager) external initializer {
        __Router_initialize(_abacusConnectionManager);
    }

    function _handle(
        uint32,
        bytes32,
        bytes memory
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

    function dispatchToRemoteRouter(uint32 _destination, bytes calldata _msg)
        external
        returns (uint256)
    {
        return _dispatch(_destination, _msg);
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

    function dispatchAndCheckpoint(uint32 _destination, bytes memory _msg)
        external
    {
        _dispatchAndCheckpoint(_destination, _msg);
    }

    function dispatchWithGasAndCheckpoint(
        uint32 _destination,
        bytes memory _msg,
        uint256 _gasPayment
    ) external payable {
        _dispatchWithGasAndCheckpoint(_destination, _msg, _gasPayment);
    }
}
