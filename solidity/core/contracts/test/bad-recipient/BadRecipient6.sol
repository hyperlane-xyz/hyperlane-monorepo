// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";

contract BadRecipient6 is IMessageRecipient {
    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external payable override {
        require(false); // solhint-disable-line reason-string
    }
}
