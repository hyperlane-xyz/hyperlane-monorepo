// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {AbstractWormholeHookIsm} from "./AbstractWormholeHookIsm.sol";
import {WormholeMessage} from "../../libs/WormholeMessage.sol";
import {AbstractCcipReadIsm} from "../../isms/ccip-read/AbstractCcipReadIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IWormholeVaaService} from "../../interfaces/wormhole/IWormholeVaaService.sol";
import {RemoteRouterEnrollment} from "../../interfaces/wormhole/IWormholeHookIsm.sol";
import {Message} from "../../libs/Message.sol";
import {WormholeConsistencyLevelConfig} from "./libs/CustomConsistencyLevel.sol";

/**
 * @title WormholeVaaHookIsm
 * @notice Wormhole hook/ISM router that obtains the VAA through Hyperlane's
 * CCIP-read metadata path and verifies it atomically inside `Mailbox.process`.
 * @dev No destination preauthorization state exists. The Mailbox writes
 * delivery state before calling `verify` and reverts it if verification fails,
 * which is sufficient replay protection for the normal path.
 */
contract WormholeVaaHookIsm is AbstractWormholeHookIsm, AbstractCcipReadIsm {
    using Message for bytes;

    // ============ Errors ============

    error InvalidMetadata();

    // ============ Constructor ============

    constructor(
        address mailbox_,
        address wormhole_,
        WormholeConsistencyLevelConfig memory consistencyLevelConfig_,
        string[] memory urls_
    ) AbstractWormholeHookIsm(mailbox_, wormhole_, consistencyLevelConfig_) {
        // MailboxClient's constructor already made the deployer the owner.
        setUrls(urls_);
    }

    // ============ Enrollment ============

    /// @notice Enrolls one remote router with its complete Wormhole policy.
    function enrollRemoteRouter(
        RemoteRouterEnrollment calldata enrollment
    ) external onlyOwner {
        _enrollWormholeRemoteRouter(enrollment);
    }

    /// @notice Batch version of `enrollRemoteRouter`.
    function enrollRemoteRouters(
        RemoteRouterEnrollment[] calldata enrollments
    ) external onlyOwner {
        for (uint256 i; i < enrollments.length; ++i) {
            _enrollWormholeRemoteRouter(enrollments[i]);
        }
    }

    // ============ IInterchainSecurityModule ============

    /**
     * @inheritdoc AbstractWormholeHookIsm
     * @dev Disambiguates the declaration inherited from both
     * `AbstractWormholeHookIsm` and `AbstractCcipReadIsm`'s `ICcipReadIsm`.
     * The body must stay identical to the base wrapper.
     */
    function verify(
        bytes calldata metadata,
        bytes calldata message
    )
        external
        override(AbstractWormholeHookIsm, IInterchainSecurityModule)
        returns (bool)
    {
        return _AbstractWormholeHookIsm_verify(metadata, message);
    }

    // ============ CCIP read ============

    /// @inheritdoc AbstractCcipReadIsm
    function _offchainLookupCalldata(
        bytes calldata message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(IWormholeVaaService.getWormholeVaa, (message));
    }

    /// @inheritdoc AbstractWormholeHookIsm
    function _AbstractWormholeHookIsm_verify(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (bool) {
        bytes memory encodedVaa = _decodeVaaMetadata(metadata);

        (, WormholeMessage.Message memory wm) = _decodeAndValidateVaa(
            encodedVaa
        );

        if (wm.originDomain != message.origin()) revert WrongOriginDomain();
        if (wm.destinationDomain != message.destination()) {
            revert WrongDestinationDomain();
        }
        if (wm.messageId != message.id()) revert WrongMessageId();
        if (wm.nonce != message.nonce()) revert HyperlaneNonceMismatch();
        return true;
    }

    /**
     * @dev CCIP-read returns the ABI-encoded outputs of `getWormholeVaa(bytes)`,
     * i.e. exactly one dynamic `bytes` with a canonical head. Rejecting any
     * other shape keeps raw, truncated, or trailing-garbage metadata out.
     */
    function _decodeVaaMetadata(
        bytes calldata metadata
    ) internal pure returns (bytes memory encodedVaa) {
        if (metadata.length < 64) revert InvalidMetadata();
        uint256 offset;
        assembly {
            offset := calldataload(metadata.offset)
        }
        if (offset != 32) revert InvalidMetadata();
        encodedVaa = abi.decode(metadata, (bytes));
        uint256 paddedVaaLength = (encodedVaa.length + 31) & ~uint256(31);
        if (metadata.length != 64 + paddedVaaLength) revert InvalidMetadata();
    }
}
