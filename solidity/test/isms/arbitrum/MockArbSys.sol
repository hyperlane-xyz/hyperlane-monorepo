// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

contract MockArbSys is ArbSys {
    address internal aliasedAddress;

    function setCallerAddress(address _aliasedAddress) external {
        aliasedAddress = _aliasedAddress;
    }

    // only needed this to mock
    function wasMyCallersAddressAliased() external pure returns (bool) {
        return true;
    }

    function arbBlockNumber() external pure returns (uint256) {
        return 123456;
    }

    function arbBlockHash(uint256 arbBlockNum) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(arbBlockNum));
    }

    function arbChainID() external pure returns (uint256) {
        return 42161;
    }

    function arbOSVersion() external pure returns (uint256) {
        return 65;
    }

    function getStorageGasAvailable() external pure returns (uint256) {
        return 0;
    }

    function isTopLevelCall() external pure returns (bool) {
        return true;
    }

    function mapL1SenderContractAddressToL2Alias(
        address sender,
        address /*unused*/
    ) external pure returns (address) {
        return AddressAliasHelper.applyL1ToL2Alias(sender);
    }

    function myCallersAddressWithoutAliasing() external view returns (address) {
        return AddressAliasHelper.undoL1ToL2Alias(aliasedAddress);
    }

    function withdrawEth(
        address /*destination*/
    ) external payable returns (uint256) {
        return 0;
    }

    function sendTxToL1(
        address, /*destination*/
        bytes calldata /*data*/
    ) external payable returns (uint256) {
        return 0;
    }

    function sendMerkleTreeState()
        external
        pure
        returns (
            uint256 size,
            bytes32 root,
            bytes32[] memory partials
        )
    {
        return (0, bytes32(0), new bytes32[](0));
    }
}
