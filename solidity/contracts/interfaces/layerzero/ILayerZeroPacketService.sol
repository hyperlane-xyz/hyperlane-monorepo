// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

interface ILayerZeroPacketService {
    function getLayerZeroPacket(
        bytes calldata hyperlaneMessage
    )
        external
        view
        returns (address receiveLibrary, bytes memory encodedPacket);
}
