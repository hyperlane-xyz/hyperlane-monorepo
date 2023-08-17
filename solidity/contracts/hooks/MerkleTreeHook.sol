// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {MerkleLib, TREE_DEPTH} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {Indexed} from "../Indexed.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract MerkleTreeHook is IPostDispatchHook, MailboxClient, Indexed {
    using Message for bytes;
    using MerkleLib for MerkleLib.Tree;

    // An incremental merkle tree used to store outbound message IDs.
    MerkleLib.Tree internal _tree;

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    function count() public view returns (uint32) {
        return uint32(_tree.count);
    }

    function root() public view returns (bytes32) {
        return _tree.root();
    }

    function branch() public view returns (bytes32[TREE_DEPTH] memory) {
        return _tree.branch;
    }

    function tree() public view returns (MerkleLib.Tree memory) {
        return _tree;
    }

    function latestCheckpoint() external view returns (bytes32, uint32) {
        return (root(), count() - 1);
    }

    function postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata message
    ) external payable override {
        bytes32 id = message.id();
        require(isLatestDispatched(id), "message not dispatching");
        _tree.insert(id);
    }
}
