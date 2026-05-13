// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title BlacklistIsm
 * @notice Rejects messages whose ID is blacklisted.
 * Provides per-message-ID granularity for blocking reorged or malicious messages.
 * For bulk nonce-range blocking, prefer NonceFloorIsm composed with DomainRoutingIsm.
 */
contract BlacklistIsm is IInterchainSecurityModule, Ownable, PackageVersioned {
    using Message for bytes;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    uint8 public constant override moduleType = uint8(Types.NULL);

    EnumerableSet.Bytes32Set private _blacklistedIds;

    event MessageBlacklisted(bytes32 indexed messageId);
    event MessageWhitelisted(bytes32 indexed messageId);

    constructor(address _owner) Ownable() {
        _transferOwnership(_owner);
    }

    /// @notice Blacklist a batch of message IDs
    function blacklist(bytes32[] calldata _ids) external onlyOwner {
        for (uint256 i = 0; i < _ids.length; i++) {
            _blacklistedIds.add(_ids[i]);
            emit MessageBlacklisted(_ids[i]);
        }
    }

    /// @notice Remove message IDs from the blacklist
    function whitelist(bytes32[] calldata _ids) external onlyOwner {
        for (uint256 i = 0; i < _ids.length; i++) {
            _blacklistedIds.remove(_ids[i]);
            emit MessageWhitelisted(_ids[i]);
        }
    }

    /// @notice Returns all blacklisted message IDs
    function blacklistedIds() external view returns (bytes32[] memory) {
        return _blacklistedIds.values();
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        return !_blacklistedIds.contains(_message.id());
    }
}
