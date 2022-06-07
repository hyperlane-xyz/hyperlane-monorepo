// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IMailbox} from "./IMailbox.sol";
import {MerkleLib} from "../libs/Merkle.sol";

interface IInbox is IMailbox {
    function remoteDomain() external returns (uint32);

    function process(
        Signature calldata _sig,
        Checkpoint calldata _checkpoint,
        MerkleLib.Proof calldata _proof,
        bytes calldata _message
    ) external;

    function batchProcess(
        Checkpoint calldata _checkpoint,
        Signature calldata _sig,
        MerkleLib.Proof[] calldata _proofs,
        bytes[] calldata _messages
    ) external;
}
