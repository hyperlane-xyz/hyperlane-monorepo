// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.9;

import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";

contract BadRecipient2 is IMessageRecipient {
    function handle(
        uint32,
        bytes32,
        bytes memory
    ) external pure override {
        assembly {
            return(0, 0)
        }
    }
}
