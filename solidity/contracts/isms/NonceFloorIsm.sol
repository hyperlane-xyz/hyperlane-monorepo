// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

/**
 * @title NonceFloorIsm
 * @notice Rejects messages with nonce <= floor.
 * Designed to block reorged/replayed messages after a chain reorganization.
 * Scope to specific origins by composing with DomainRoutingIsm.
 */
contract NonceFloorIsm is IInterchainSecurityModule, PackageVersioned {
    using Message for bytes;

    uint8 public constant override moduleType = uint8(Types.NULL);

    /// @notice Messages with nonce <= this value are rejected
    uint32 public immutable nonceFloor;

    /// @param _nonceFloor The highest rejected nonce (inclusive)
    constructor(uint32 _nonceFloor) {
        require(_nonceFloor > 0, "floor must be > 0");
        nonceFloor = _nonceFloor;
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        return _message.nonce() > nonceFloor;
    }
}
