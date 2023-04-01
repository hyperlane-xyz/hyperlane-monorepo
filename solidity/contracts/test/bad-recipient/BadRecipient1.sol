// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

contract BadRecipient1 is IMessageRecipient {
    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external pure override {
        assembly {
            revert(0, 0)
        }
    }
}
