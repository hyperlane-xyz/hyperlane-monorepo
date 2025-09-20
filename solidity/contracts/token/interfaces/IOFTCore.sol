 // SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IOFTCore {
    function sendFrom(
        address from,
        uint16 dstChainId,
        bytes calldata toAddress,
        uint256 amount,
        bytes calldata adapterParams
    ) external payable;
}
