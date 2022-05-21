// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";

interface IInbox is ICommon {
    function remoteDomain() external returns (uint32);

    function process(
        bytes calldata _message,
        bytes32 _baseCommitment,
        bytes32 _commitment,
        bytes calldata _sovereignData
    ) external;
}
