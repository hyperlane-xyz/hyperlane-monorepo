// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/// @notice Guardian signature over a VAA body, as returned by Wormhole Core.
struct CoreBridgeSignature {
    bytes32 r;
    bytes32 s;
    uint8 v;
    uint8 guardianIndex;
}

/// @notice Parsed VAA as returned by Wormhole Core `parseAndVerifyVM`.
/// @dev `hash` is Core's double-keccak digest of the VAA body; it is the
/// canonical replay key because it does not cover Guardian signatures.
struct CoreBridgeVM {
    uint8 version;
    uint32 timestamp;
    uint32 nonce;
    uint16 emitterChainId;
    bytes32 emitterAddress;
    uint64 sequence;
    uint8 consistencyLevel;
    bytes payload;
    uint32 guardianSetIndex;
    CoreBridgeSignature[] signatures;
    bytes32 hash;
}

/**
 * @title ICoreBridge
 * @notice Minimal view of the Wormhole Core contract used by the Hyperlane
 * Wormhole hook/ISM routers.
 * @dev Mirrors `wormhole-sdk/interfaces/ICoreBridge.sol` from Wormhole Solidity
 * SDK v1.1.0. Only the members this integration calls are declared; the
 * declarations are ABI-compatible with the deployed Core proxies so the import
 * can be swapped for the pinned SDK without touching call sites.
 */
interface ICoreBridge {
    /**
     * @notice Publishes `payload` for Guardian observation.
     * @param nonce Application-defined `uint32`. This integration copies the
     * Hyperlane message nonce into it.
     * @param payload Arbitrary bytes committed by the Guardian signatures.
     * @param consistencyLevel Origin finality policy requested from Guardians.
     * @return sequence Core-assigned, per-emitter monotonic VAA locator.
     */
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);

    /**
     * @notice Verifies Guardian signatures and parses a VAA.
     * @dev Malformed input may revert inside Core rather than return
     * `valid == false`. Callers must not catch and hide either outcome.
     */
    function parseAndVerifyVM(
        bytes calldata encodedVaa
    )
        external
        view
        returns (CoreBridgeVM memory vm, bool valid, string memory reason);

    /// @notice Native fee required by `publishMessage`.
    function messageFee() external view returns (uint256);

    /// @notice Wormhole's `uint16` chain namespace for this deployment.
    function chainId() external view returns (uint16);

    /// @notice EVM chain ID this Core deployment is configured for.
    function evmChainId() external view returns (uint256);

    /// @notice Sequence that the next `publishMessage` by `emitter` will use.
    function nextSequence(address emitter) external view returns (uint64);
}
