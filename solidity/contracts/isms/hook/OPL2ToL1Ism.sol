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
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============

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
    using Message for bytes;
    // ============ Constants ============

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OP_L2_TO_L1);
    // OptimismPortal contract on L1 to finalize withdrawal from L1
    IOptimismPortal public portal;

    // ============ Constructor ============

    constructor(address _portal) CrossChainEnabledOptimism(_portal) {
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
        bool verified = isVerified(message);
        if (verified) {
            releaseValueToRecipient(message);
        }
        return verified || _verifyWithPortalCall(metadata, message);
    }

    // ============ Internal function ============

    /**
     * @notice Verify message directly using the portal.finalizeWithdrawal function.
     * @dev This is a fallback in case the message is not verified by the stateful verify function first.
     */
    function _verifyWithPortalCall(
        bytes calldata metadata,
        bytes calldata message
    ) internal returns (bool) {
        (
            uint256 nonce,
            address sender,
            address target,
            uint256 value,
            uint256 gasLimit,
            bytes memory data
        ) = abi.decode(
                metadata,
                (uint256, address, address, uint256, uint256, bytes)
            );

        // this data is an abi encoded call of verifyMessageId(bytes32 messageId)
        require(data.length == 36, "OPL2ToL1Ism: invalid data length");
        bytes32 messageId = message.id();
        bytes32 convertedBytes;
        assembly {
            // data = 0x[4 bytes function signature][32 bytes messageId]
            convertedBytes := mload(add(data, 36))
        }
        // check if the parsed message id matches the message id of the message
        require(convertedBytes == messageId, "OPL2ToL1Ism: invalid message id");

        // Types.WithdrawalTransaction memory withdrawal =
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: nonce,
                sender: sender,
                target: target,
                value: value,
                gasLimit: gasLimit,
                data: data
            });

        portal.finalizeWithdrawalTransaction(withdrawal);

        // check if the sender of the l2 message is the authorized hook
        require(_isAuthorized(), "OPL2ToL1Ism: unauthorized sender");

        return true;
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
