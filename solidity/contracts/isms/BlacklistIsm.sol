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
 * @dev Negative filtering only: `verify` returns true for any non-blacklisted
 * message and provides NO positive authentication. Compose it as a mandatory
 * member of an `AggregationIsm` (counted by the threshold) alongside an
 * authenticating ISM such as a multisig ISM. Never route a domain directly to
 * this ISM via `DomainRoutingIsm` — that removes all authentication for the
 * affected messages.
 * @dev Append-only: entries are permanent and cannot be removed. Wrap it in an
 * `AggregationIsm` you control (which a `DomainRoutingIsm` may in turn route to)
 * so the module can be swapped if recovery is needed.
 */
contract BlacklistIsm is IInterchainSecurityModule, Ownable, PackageVersioned {
    using Message for bytes;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    uint8 public constant override moduleType = uint8(Types.NULL);

    /// @notice Set of blacklisted message IDs (append-only).
    EnumerableSet.Bytes32Set private _blacklistedIds;

    event MessageBlacklisted(bytes32 indexed messageId);

    constructor(address _owner) Ownable() {
        _transferOwnership(_owner);
    }

    /**
     * @notice Blacklist a batch of message IDs.
     * @dev Entries are permanent; there is no removal path by design.
     */
    function blacklist(bytes32[] calldata _ids) external onlyOwner {
        for (uint256 i = 0; i < _ids.length; i++) {
            if (_blacklistedIds.add(_ids[i])) {
                emit MessageBlacklisted(_ids[i]);
            }
        }
    }

    /// @notice Returns true if the message ID is blacklisted.
    function blacklistedIds(bytes32 _id) external view returns (bool) {
        return _blacklistedIds.contains(_id);
    }

    /// @notice Returns all blacklisted message IDs, enabling off-chain enumeration.
    function values() external view returns (bytes32[] memory) {
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
