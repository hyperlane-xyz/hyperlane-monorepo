// SPDX-License-Identifier: MIT OR Apache-2.0

// work based on eth2 deposit contract, which is used under CC0-1.0

pragma solidity >=0.6.11;

library MerkleLib {
    uint256 constant TREE_DEPTH = 32;
    uint256 constant MAX_LEAVES = 2**TREE_DEPTH - 1;

    struct Tree {
        bytes32[TREE_DEPTH] branch;
        uint256 count;
    }

    function branchRoot(
        bytes32 item,
        bytes32[32] memory branch,
        uint256 index,
        bytes32[TREE_DEPTH] storage zero_hashes
    ) internal view returns (bytes32 node) {
        uint256 idx = index;
        node = item;
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            if ((idx & 1) == 1)
                node = sha256(abi.encodePacked(branch[i], node));
            else node = sha256(abi.encodePacked(node, zero_hashes[i]));
            idx /= 2;
        }
    }

    function root(Tree storage _tree, bytes32[TREE_DEPTH] storage zero_hashes)
        internal
        view
        returns (bytes32 node)
    {
        return branchRoot(bytes32(0), _tree.branch, _tree.count, zero_hashes);
    }

    function insert(Tree storage _tree, bytes32 node) internal {
        require(_tree.count < MAX_LEAVES, "merkle tree full");

        _tree.count += 1;
        uint256 size = _tree.count;
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            if ((size & 1) == 1) {
                _tree.branch[i] = node;
                return;
            }
            node = sha256(abi.encodePacked(_tree.branch[i], node));
            size /= 2;
        }
        // As the loop should always end prematurely with the `return` statement,
        // this code should be unreachable. We assert `false` just to be safe.
        assert(false);
    }
}

contract MerkleTreeManager {
    using MerkleLib for MerkleLib.Tree;
    uint256 constant TREE_DEPTH = 32;

    bytes32[TREE_DEPTH] internal zero_hashes;
    MerkleLib.Tree public tree;

    constructor() {
        // Compute hashes in empty sparse Merkle tree
        for (uint256 i = 0; i < MerkleLib.TREE_DEPTH - 1; i++)
            zero_hashes[i + 1] = sha256(
                abi.encodePacked(zero_hashes[i], zero_hashes[i])
            );
    }

    function root() public view returns (bytes32) {
        return tree.root(zero_hashes);
    }
}
