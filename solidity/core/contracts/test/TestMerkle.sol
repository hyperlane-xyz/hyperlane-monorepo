// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "../MerkleTreeManager.sol";

contract TestMerkle is MerkleTreeManager {
    using MerkleLib for MerkleLib.Tree;

    // solhint-disable-next-line no-empty-blocks
    constructor() MerkleTreeManager() {}

    function insert(bytes32 _node) external {
        tree.insert(_node);
    }

    function branchRoot(MerkleLib.Proof calldata _proof)
        external
        pure
        returns (bytes32 _node)
    {
        return MerkleLib.branchRoot(_proof);
    }

    /**
     * @notice Returns the number of inserted leaves in the tree
     */
    function count() public view returns (uint256) {
        return tree.count;
    }
}
