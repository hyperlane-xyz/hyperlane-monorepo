// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {MerkleLib} from "../libs/Merkle.sol";
import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {Indexed} from "../libs/Indexed.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";

contract MerkleTreeHook is AbstractPostDispatchHook, MailboxClient, Indexed {
    using Message for bytes;
    using MerkleLib for MerkleLib.Tree;
    using StandardHookMetadata for bytes;

    // An incremental merkle tree used to store outbound message IDs.
    MerkleLib.Tree internal _tree;

    event InsertedIntoTree(bytes32 messageId, uint32 index);

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    // count cannot exceed 2**TREE_DEPTH, see MerkleLib.sol
    function count() public view returns (uint32) {
        return uint32(_tree.count);
    }

    function root() public view returns (bytes32) {
        return _tree.root();
    }

    function tree() public view returns (MerkleLib.Tree memory) {
        return _tree;
    }

    function latestCheckpoint() external view returns (bytes32, uint32) {
        return (root(), count() - 1);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.MERKLE_TREE);
    }

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata message
    ) internal override {
        require(msg.value == 0, "MerkleTreeHook: no value expected");

        // ensure messages which were not dispatched are not inserted into the tree
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "message not dispatching");

        uint32 index = count();
        _tree.insert(id);
        emit InsertedIntoTree(id, index);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) internal pure override returns (uint256) {
        return 0;
    }
}
