// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";
import {MessageFingerprint} from "../../../libs/Message.sol";

contract BadRecipient5 is IMessageRecipient {
    function handle(
        MessageFingerprint calldata,
        bytes calldata
    ) external pure override {
        require(false, "no can do");
    }
}
