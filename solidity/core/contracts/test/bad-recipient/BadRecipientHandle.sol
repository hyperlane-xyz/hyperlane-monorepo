// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {MessageFingerprint} from "../../../libs/Message.sol";

contract BadRecipientHandle {
    function handle(MessageFingerprint calldata, bytes calldata) external pure {} // solhint-disable-line no-empty-blocks
}
