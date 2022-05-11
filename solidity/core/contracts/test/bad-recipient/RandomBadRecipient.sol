// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";
import {MessageFingerprint} from "../../../libs/Message.sol";

contract BadRandomRecipient is IMessageRecipient {
    event Handled(bytes32 blockHash);

    function handle(
        MessageFingerprint calldata,
        bytes calldata
    ) external override {
        bool isBlockHashEven = uint256(blockhash(block.number - 1)) % 2 == 0;
        require(isBlockHashEven, "block hash is odd");
        emit Handled(blockhash(block.number - 1));
    }
}
