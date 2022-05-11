// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {MessageFingerprint} from "../libs/Message.sol";

interface IMessageRecipient {
    function handle(MessageFingerprint calldata fingerprint, bytes calldata _message) external;
}
