// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {MerkleLib} from "./libs/Merkle.sol";

/**
 * @title MerkleTreeManager
 * @author Celo Labs Inc.
 * @notice Contains a Merkle tree instance and
 * exposes view functions for the tree.
 */
contract MerkleTreeManager {
    // ============ Libraries ============

    using MerkleLib for MerkleLib.Tree;
    MerkleLib.Tree public tree;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[49] private __GAP;

    // ============ Public Functions ============

    /**
     * @notice Calculates and returns tree's current root
     */
    function root() public view returns (bytes32) {
        return tree.root();
    }
}
