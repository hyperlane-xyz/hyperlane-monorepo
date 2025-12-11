// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../client/GasRouter.sol";

contract TestGasRouter is GasRouter {
    constructor(address _mailbox) GasRouter(_mailbox) {}

    function dispatch(uint32 _destination, bytes memory _msg) external payable {
        _Router_dispatch({
            _destinationDomain: _destination,
            _value: msg.value,
            _messageBody: _msg,
            _hookMetadata: _GasRouter_hookMetadata(_destination),
            _hook: address(hook)
        });
    }

    function quoteDispatch(
        uint32 _destination,
        bytes memory _msg
    ) external view returns (uint256) {
        return
            _Router_quoteDispatch({
                _destinationDomain: _destination,
                _messageBody: _msg,
                _hookMetadata: _GasRouter_hookMetadata(_destination),
                _hook: address(hook)
            });
    }

    function _handle(uint32, bytes32, bytes calldata) internal pure override {}
}
