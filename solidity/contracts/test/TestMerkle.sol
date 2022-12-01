// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {MerkleLib} from "../libs/Merkle.sol";

contract TestMerkle {
    using MerkleLib for MerkleLib.Tree;

    MerkleLib.Tree public tree;

    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    function insert(bytes32 _node) external {
        tree.insert(_node);
    }

    function branchRoot(
        bytes32 _leaf,
        bytes32[32] calldata _proof,
        uint256 _index
    ) external pure returns (bytes32 _node) {
        return MerkleLib.branchRoot(_leaf, _proof, _index);
    }

    /**
     * @notice Returns the number of inserted leaves in the tree
     */
    function count() public view returns (uint256) {
        return tree.count;
    }

    function root() public view returns (bytes32) {
        return tree.root();
    }
}
