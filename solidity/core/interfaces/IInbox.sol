// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";
import {MessageType} from "../libs/Message.sol";

interface IInbox is ICommon {
    function checkpoint(
        bytes32 _root,
        uint256 _index
    ) external;

    function remoteDomain() external returns (uint32);

    function process(
        bytes32[32] calldata _proof,
        uint256 _index,
        MessageType calldata _message,
        bytes calldata _sovereignData
    ) external;
}
