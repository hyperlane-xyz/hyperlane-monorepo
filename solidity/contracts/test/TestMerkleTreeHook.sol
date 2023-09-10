// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {MerkleLib} from "../libs/Merkle.sol";
import {MerkleTreeHook} from "../hooks/MerkleTreeHook.sol";

contract TestMerkleTreeHook is MerkleTreeHook {
    using MerkleLib for MerkleLib.Tree;

    constructor(address _mailbox) MerkleTreeHook(_mailbox) {}

    function proof() external view returns (bytes32[32] memory) {
        bytes32[32] memory _zeroes = MerkleLib.zeroHashes();
        uint256 _index = _tree.count - 1;
        bytes32[32] memory _proof;

        for (uint256 i = 0; i < 32; i++) {
            uint256 _ithBit = (_index >> i) & 0x01;
            if (_ithBit == 1) {
                _proof[i] = _tree.branch[i];
            } else {
                _proof[i] = _zeroes[i];
            }
        }
        return _proof;
    }

    function insert(bytes32 _id) external {
        _tree.insert(_id);
    }
}
