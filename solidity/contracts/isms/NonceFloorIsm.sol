// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

/**
 * @title NonceFloorIsm
 * @notice Rejects messages with nonce <= floor for a given origin domain.
 * Designed to block reorged/replayed messages after a chain reorganization.
 * Intended to be composed with other ISMs via AggregationIsm or RoutingIsm.
 */
contract NonceFloorIsm is IInterchainSecurityModule, PackageVersioned {
    using Message for bytes;

    uint8 public constant override moduleType = uint8(Types.NULL);

    /// @notice origin domain => highest rejected nonce (inclusive)
    mapping(uint32 => uint32) public nonceFloors;

    /// @notice Emitted when a nonce floor is set for an origin domain
    event NonceFloorSet(uint32 indexed origin, uint32 floor);

    /// @param origins The origin domains
    /// @param floors The nonce floors (messages with nonce <= floor are rejected)
    constructor(uint32[] memory origins, uint32[] memory floors) {
        require(origins.length == floors.length, "length mismatch");
        for (uint256 i = 0; i < origins.length; i++) {
            require(nonceFloors[origins[i]] == 0, "floor already set");
            require(floors[i] > 0, "floor must be > 0");
            nonceFloors[origins[i]] = floors[i];
            emit NonceFloorSet(origins[i], floors[i]);
        }
    }

    /// @inheritdoc IInterchainSecurityModule
    /// @dev Returns false if the message nonce is at or below the floor for its origin.
    /// Messages from origins without a floor are always accepted.
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        uint32 floor = nonceFloors[_message.origin()];
        if (floor == 0) return true;
        return _message.nonce() > floor;
    }
}
