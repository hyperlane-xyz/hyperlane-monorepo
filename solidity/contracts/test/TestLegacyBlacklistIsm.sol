// SPDX-License-Identifier: MIT OR Apache-2.0
// Raised from the deployed contract's >=0.8.0: named mapping parameters, used
// verbatim below, require 0.8.18.
pragma solidity >=0.8.18;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestLegacyBlacklistIsm
 * @notice Copy of the pre-audit BlacklistIsm that is deployed on mainnet, kept
 * as a test fixture so the SDK can be exercised against a real non-enumerable
 * deployment. It has no `values()` and its `blacklist` emits an event for every
 * entry, including re-adds of an already blacklisted ID. Only the contract name
 * and the pragma differ from the deployed source.
 * @dev Not for production use; the current BlacklistIsm supersedes it.
 */
contract TestLegacyBlacklistIsm is
    IInterchainSecurityModule,
    Ownable,
    PackageVersioned
{
    using Message for bytes;

    uint8 public constant override moduleType = uint8(Types.NULL);

    /// @notice message ID => true if blacklisted
    mapping(bytes32 messageId => bool isBlacklisted) public blacklistedIds;

    event MessageBlacklisted(bytes32 indexed messageId);

    constructor(address _owner) Ownable() {
        _transferOwnership(_owner);
    }

    /// @notice Blacklist a batch of message IDs
    function blacklist(bytes32[] calldata _ids) external onlyOwner {
        for (uint256 i = 0; i < _ids.length; i++) {
            blacklistedIds[_ids[i]] = true;
            emit MessageBlacklisted(_ids[i]);
        }
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        return !blacklistedIds[_message.id()];
    }
}
