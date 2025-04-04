// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "../isms/hook/BlockHashIsm.sol";

contract MockBlockHashOracle is IBlockHashOracle {
    uint32 public immutable override origin;
    mapping(uint256 => uint256) public blockhashes;

    constructor(uint32 _origin) {
        origin = _origin;
    }

    function setBlockHash(uint256 height, uint256 hash) external {
        blockhashes[height] = hash;
    }

    function blockHash(
        uint256 height
    ) external view override returns (uint256) {
        return blockhashes[height];
    }
}
