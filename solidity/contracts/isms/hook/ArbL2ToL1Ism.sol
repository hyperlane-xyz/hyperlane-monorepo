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

import {IBridge} from "@arbitrum/nitro-contracts/src/bridge/IBridge.sol";
import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/IOutbox.sol";
import {CrossChainEnabledArbitrumL1} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL1.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbL2ToL1Ism
 * @notice Uses the native Arbitrum bridge to verify interchain messages from L2 to L1.
 */
contract ArbL2ToL1Ism is
    CrossChainEnabledArbitrumL1,
    AbstractMessageIdAuthorizedIsm
{
    using Message for bytes;
    // ============ Constants ============

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARB_L2_TO_L1);
    // arbitrum nitro contract on L1 to forward verification
    IOutbox public arbOutbox;

    uint256 private constant DATA_LENGTH = 68;

    uint256 private constant MESSAGE_ID_END = 36;

    // ============ Constructor ============

    constructor(address _bridge) CrossChainEnabledArbitrumL1(_bridge) {
        require(
            Address.isContract(_bridge),
            "ArbL2ToL1Ism: invalid Arbitrum Bridge"
        );
        arbOutbox = IOutbox(IBridge(_bridge).activeOutbox());
    }

    // ============ External Functions ============

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        if (!isVerified(message)) {
            _verifyWithOutboxCall(metadata, message);
            require(isVerified(message), "ArbL2ToL1Ism: message not verified");
        }
        _releaseValueToRecipient(message);
        return true;
    }

    // ============ Internal function ============

    /**
     * @notice Verify message directly using the arbOutbox.executeTransaction function.
     * @dev This is a fallback in case the message is not verified by the stateful verify function first.
     * @dev This function doesn't support msg.value as the ism.verify call doesn't support it either.
     */
    function _verifyWithOutboxCall(
        bytes calldata metadata,
        bytes calldata message
    ) internal {
        (
            bytes32[] memory proof,
            uint256 index,
            address l2Sender,
            address to,
            uint256 l2Block,
            uint256 l1Block,
            uint256 l2Timestamp,
            uint256 value,
            bytes memory data
        ) = abi.decode(
                metadata,
                (
                    bytes32[],
                    uint256,
                    address,
                    address,
                    uint256,
                    uint256,
                    uint256,
                    uint256,
                    bytes
                )
            );

        // check if the sender of the l2 message is the authorized hook
        require(
            l2Sender == TypeCasts.bytes32ToAddress(authorizedHook),
            "ArbL2ToL1Ism: l2Sender != authorizedHook"
        );
        // this data is an abi encoded call of preVerifyMessage(bytes32 messageId)
        require(
            data.length == DATA_LENGTH,
            "ArbL2ToL1Ism: invalid data length"
        );
        bytes32 messageId = message.id();
        bytes32 convertedBytes;
        assembly {
            // data = 0x[4 bytes function signature][32 bytes messageId]
            convertedBytes := mload(add(data, MESSAGE_ID_END))
        }
        // check if the parsed message id matches the message id of the message
        require(
            convertedBytes == messageId,
            "ArbL2ToL1Ism: invalid message id"
        );
        arbOutbox.executeTransaction(
            proof,
            index,
            l2Sender,
            to,
            l2Block,
            l1Block,
            l2Timestamp,
            value,
            data
        );
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
