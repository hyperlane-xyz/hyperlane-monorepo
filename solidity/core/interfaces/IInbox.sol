// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";

interface IInbox is ICommon {
    function cacheCheckpoint(bytes32 _root, uint256 _index) external;

    function remoteDomain() external returns (uint32);

    function process(
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _index,
        bytes calldata _sovereignData
    ) external;
}
