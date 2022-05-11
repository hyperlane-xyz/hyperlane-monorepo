// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";
import {MessageHeader} from "../libs/Message.sol";

interface IOutbox is ICommon {
    function dispatch(
        MessageHeader calldata _header,
        bytes calldata _body
    ) external returns (uint256);

    function checkpoint() external;

    function isCheckpoint(
        bytes32 _root,
        uint256 _index
    ) external returns (bool);

    function fail() external;
}
