// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IWormhole
 * @notice Minimal interface for the Wormhole Core Bridge used by the
 * Hyperlane Wormhole hook/ISM experiment. Only the methods we need.
 */
interface IWormhole {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint8 guardianIndex;
    }

    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        Signature[] signatures;
        bytes32 hash;
    }

    /// @notice Publish a message to the guardian network. Returns the sequence.
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);

    /// @notice Parse and verify a signed VAA against the current guardian set.
    function parseAndVerifyVM(
        bytes calldata encodedVM
    ) external view returns (VM memory vm, bool valid, string memory reason);

    /// @notice Fee (in native token) charged by publishMessage.
    function messageFee() external view returns (uint256);

    /// @notice The Wormhole chain id of this chain (not the EVM chain id).
    function chainId() external view returns (uint16);
}
