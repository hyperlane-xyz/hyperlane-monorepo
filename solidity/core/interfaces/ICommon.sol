// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface ICommon {
    function localDomain() external view returns (uint32);

    function latestCheckpoint()
        external
        view
        returns (bytes32 root, uint256 index);
}
