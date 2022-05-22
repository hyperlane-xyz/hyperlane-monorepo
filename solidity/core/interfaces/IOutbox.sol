// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {ICommon} from "./ICommon.sol";

interface IOutbox is ICommon {
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (uint256);

    function fail() external;
    function root() external view returns (bytes32);
    function verifyMerkleProof(bytes32 _root, bytes32 _leaf, bytes32[32] calldata _proof, uint256 _index) external pure returns (bool);
}
