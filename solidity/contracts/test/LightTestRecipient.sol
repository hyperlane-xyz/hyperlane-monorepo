// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.17;

import "./TestRecipient.sol";

contract LightTestRecipient is TestRecipient {
    // solhint-disable-next-line no-empty-blocks
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data
    ) external override {
        // do nothing
    }
}
