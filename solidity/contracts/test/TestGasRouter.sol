// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../client/GasRouter.sol";

contract TestGasRouter is GasRouter {
    constructor(address _mailbox) GasRouter(_mailbox) {}

    function dispatch(uint32 _destination, bytes memory _msg) external payable {
        _GasRouter_dispatch(_destination, msg.value, _msg, address(hook));
    }

    function _handle(uint32, bytes32, bytes calldata) internal pure override {}
}
