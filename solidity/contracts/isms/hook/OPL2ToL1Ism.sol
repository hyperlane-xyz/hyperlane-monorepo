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
    // ============ Constants ============

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OP_L2_TO_L1);
    // bottom offset to the start of message id in the metadata
    uint8 public constant MESSAGE_ID_OFFSET = 88;
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
        // metadata here is double encoded call relayMessage(..., verifyMessageId)
        (
            uint256 nonce,
            address sender,
            address target,
            uint256 value,
            uint256 gasLimit,
            bytes memory messengerData
        ) = abi.decode(
                metadata,
                (uint256, address, address, uint256, uint256, bytes)
            );

        // this data is an abi encoded call of ICrossDomainMessenger.relayMessage
        // Σ {
        //      _selector                       =  4 bytes
        //      _nonce                          = 32 bytes
        //      PADDING + _sender               = 32 bytes
        //      PADDING + _target               = 32 bytes
        //      _value                          = 32 bytes
        //      _minGasLimit                    = 32 bytes
        //      _data
        //          OFFSET                      = 32 bytes
        //          LENGTH                      = 32 bytes
        //          PADDING + verifyMessageId   = 64 bytes
        // } = 292 bytes
        require(
            messengerData.length == 292,
            "OPL2ToL1Ism: invalid data length"
        );
        bytes32 messageId = message.id();
        uint256 metadataLength = metadata.length;

        bytes32 convertedBytes = bytes32(
            metadata[metadataLength - MESSAGE_ID_OFFSET:metadataLength -
                MESSAGE_ID_OFFSET +
                32]
        );
        require(convertedBytes == messageId, "OPL2ToL1Ism: invalid message id");

        // directly call the portal to finalize the withdrawal
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: nonce,
                sender: sender, // Sender is the L2Messenger
                target: target, // Target is the L1Messenger
                value: value,
                gasLimit: gasLimit,
                data: messengerData
            });
        portal.finalizeWithdrawalTransaction(withdrawal);

        // if the finalizeWithdrawalTransaction call is successful, the message is verified
        return true;
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
