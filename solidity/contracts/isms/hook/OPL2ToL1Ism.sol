// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Message} from "../../libs/Message.sol";
import {OPL2ToL1Metadata} from "../../libs/OPL2ToL1Metadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============

import {ICrossDomainMessenger} from "../../interfaces/optimism/ICrossDomainMessenger.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {CrossChainEnabledOptimism} from "@openzeppelin/contracts/crosschain/optimism/CrossChainEnabledOptimism.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OPL2ToL1Ism
 * @notice Uses the native Optimism bridge to verify interchain messages from L2 to L1.
 */
contract OPL2ToL1Ism is
    CrossChainEnabledOptimism,
    AbstractMessageIdAuthorizedIsm
{
    using TypeCasts for address;
    using Message for bytes;
    using OPL2ToL1Metadata for bytes;

    // ============ Constants ============

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OP_L2_TO_L1);
    // OptimismPortal contract on L1 to finalize withdrawal from L1
    IOptimismPortal public immutable portal;

    // ============ Constructor ============

    constructor(address _messenger) CrossChainEnabledOptimism(_messenger) {
        address _portal = ICrossDomainMessenger(_messenger).PORTAL();
        require(
            Address.isContract(_portal),
            "OPL2ToL1Ism: invalid OptimismPortal contract"
        );
        portal = IOptimismPortal(_portal);
    }

    // ============ External Functions ============

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        if (!isVerified(message)) {
            _verifyWithPortalCall(metadata, message);
            require(isVerified(message), "OPL2ToL1Ism: message not verified");
        }
        releaseValueToRecipient(message);
        return true;
    }

    // ============ Internal function ============

    /**
     * @notice Verify message directly using the portal.finalizeWithdrawal function.
     * @dev This is a fallback in case the message is not verified by the stateful verify function first.
     */
    function _verifyWithPortalCall(
        bytes calldata metadata,
        bytes calldata message
    ) internal {
        require(
            metadata.checkCalldataLength(),
            "OPL2ToL1Ism: invalid data length"
        );
        require(
            metadata.messageId() == message.id(),
            "OPL2ToL1Ism: invalid message id"
        );

        IOptimismPortal.WithdrawalTransaction memory withdrawal = abi.decode(
            metadata,
            (IOptimismPortal.WithdrawalTransaction)
        );
        // if the finalizeWithdrawalTransaction call is successful, the message is verified
        portal.finalizeWithdrawalTransaction(withdrawal);
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
