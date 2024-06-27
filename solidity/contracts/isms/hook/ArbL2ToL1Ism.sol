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

import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/IOutbox.sol";
import {CrossChainEnabledArbitrumL1} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL1.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ArbL2ToL1Ism
 * @notice Uses the native Arbitrum bridge to verify interchain messages from L2 to L1.
 */
contract ArbL2ToL1Ism is
    CrossChainEnabledArbitrumL1,
    AbstractMessageIdAuthorizedIsm
{
    using Address for address payable;
    using Message for bytes;
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARB_L2_TO_L1);

    IOutbox public arbOutbox;

    // ============ Constructor ============

    constructor(
        address _bridge,
        address _outbox
    ) CrossChainEnabledArbitrumL1(_bridge) {
        require(
            Address.isContract(_bridge),
            "ArbL2ToL1Ism: invalid Arbitrum Bridge"
        );
        arbOutbox = IOutbox(_outbox);
    }

    // ============ External Functions ============

    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        return
            _statefulVerify(metadata, message) ||
            _verifyWithOutboxCall(metadata, message);
    }

    // ============ Internal function ============

    function _verifyWithOutboxCall(
        bytes calldata metadata,
        bytes calldata message
    ) internal returns (bool) {
        (
            bytes32[] memory proof,
            uint256 index,
            address l2Sender,
            address to,
            uint256 l2Block,
            uint256 l1Block,
            uint256 l2Timestamp,
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
                    bytes
                )
            );

        require(
            l2Sender == TypeCasts.bytes32ToAddress(authorizedHook),
            "ArbL2ToL1Ism: l2Sender != authorizedHook"
        );

        bytes32 messageId = message.id();
        {
            bytes32 convertedBytes;
            assembly {
                convertedBytes := mload(add(data, 36))
            }
            require(
                convertedBytes == messageId,
                "ArbL2ToL1Ism: invalid message id"
            );
        }

        arbOutbox.executeTransaction(
            proof,
            index,
            l2Sender,
            to,
            l2Block,
            l1Block,
            l2Timestamp,
            0,
            data
        );

        return true;
    }

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
