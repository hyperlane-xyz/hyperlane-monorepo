// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

/**
 * @notice Requires that a message with the specified payload was published
 * by the specified emitter.
 * @dev Relayers expect the emitter to be an IWormholeMessageHook, and rely on
 * the WormholeMessagePublished event to be emitted by the emitter in order
 * to query metadata.
 */
interface IWormholeIsm is IInterchainSecurityModule {
    /**
     * @notice Returns the wormhole message emitter and payload needed to
     * verify _message
     * @dev Emitter must emit the WormholeMessageEmitted event
     * @param _message Hyperlane formatted interchain message
     * @return emitter the address that published the payload to wormhole
     * @return payload the wormhole message payload associated with _message
     */
    function emitterAndPayload(bytes calldata _message)
        external
        view
        returns (bytes32 emitter, bytes32 payload);
}
