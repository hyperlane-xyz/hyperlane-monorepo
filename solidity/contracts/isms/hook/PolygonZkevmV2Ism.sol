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

import {LibBit} from "../../libs/LibBit.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {AbstractMessageIdAuthorizedIsm} from "../hook/AbstractMessageIdAuthorizedIsm.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";

// ============ External Imports ============

import {IPolygonZkEVMBridgeV2} from "../../interfaces/polygonZkevm/IPolygonZkEVMBridgeV2.sol";
import {IBridgeMessageReceiver} from "../../interfaces/polygonZkevm/IBridgeMessageReceiver.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonZkevmV2Ism
 * @notice Polygon zkEVM chain Ism that uses the Polygon zkEVM bridge to verify messages
 */
contract PolygonZkevmV2Ism is
    ICcipReadIsm,
    AbstractMessageIdAuthorizedIsm,
    IBridgeMessageReceiver
{
    using Message for bytes;
    using LibBit for uint256;
    using TypeCasts for bytes32;
    using Address for address payable;

    IMailbox public mailbox;
    string[] public offchainUrls;

    // ============ Constants ============
    IPolygonZkEVMBridgeV2 public immutable zkEvmBridge;
    uint8 public constant override moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);
    uint32 public immutable zkEvmBridgeDestinationNetId;

    // ============ Constructor ============
    constructor(
        address _zkEvmBridge,
        uint32 _zkEvmBridgeDestinationNetId,
        address _mailbox,
        string[] memory _offchainUrls
    ) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonZkevmV2Ism: invalid ZkEVMBridge"
        );
        require(
            Address.isContract(_mailbox),
            "PolygonZkevmV2Ism: invalid Mailbox"
        );
        require(
            _zkEvmBridgeDestinationNetId <= 1,
            "PolygonZkevmV2Ism: invalid ZkEVMBridge destination network id"
        );
        zkEvmBridgeDestinationNetId = _zkEvmBridgeDestinationNetId;
        zkEvmBridge = IPolygonZkEVMBridgeV2(_zkEvmBridge);
        mailbox = IMailbox(_mailbox);
        offchainUrls = _offchainUrls;
    }

    /**
     * @dev off-chain verification information for a given message.
     * @param _message The message for which off-chain verification information is requested.
     */
    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        bytes memory messageId = abi.encodePacked(_message.id());
        revert OffchainLookup(
            address(this),
            offchainUrls,
            messageId,
            PolygonZkevmV2Ism.verify.selector,
            _message
        );
    }

    /**
     * @dev Calls the Polygon zkEVM bridge to claim the message.
     * @param _metadata from CCIP call
     * @return A boolean indicating whether the message was successfully verified and processed.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    )
        external
        override(AbstractMessageIdAuthorizedIsm, IInterchainSecurityModule)
        returns (bool)
    {
        bytes32 messageId = _message.id();
        (
            bytes32[32] memory smtProofLocalExitRoot,
            bytes32[32] memory smtProofRollupExitRoot,
            uint32 globalIndex,
            bytes32 mainnetExitRoot,
            bytes32 rollupExitRoot,
            uint32 originNetwork,
            address originAddress,
            ,
            ,
            uint256 amount,
            bytes memory payload
        ) = abi.decode(
                _metadata,
                (
                    bytes32[32],
                    bytes32[32],
                    uint32,
                    bytes32,
                    bytes32,
                    uint32,
                    address,
                    uint32,
                    address,
                    uint256,
                    bytes
                )
            );

        require(
            messageId == abi.decode(payload, (bytes32)),
            "PolygonZkevmV2Ism: message id does not match payload"
        );
        zkEvmBridge.claimMessage(
            smtProofLocalExitRoot,
            smtProofRollupExitRoot,
            globalIndex,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            originAddress,
            zkEvmBridgeDestinationNetId,
            address(this),
            amount,
            payload
        );
        uint256 _msgValue = verifiedMessages[messageId].clearBit(
            VERIFIED_MASK_INDEX
        );
        if (_msgValue > 0) {
            verifiedMessages[messageId] -= _msgValue;
            payable(_message.recipientAddress()).sendValue(_msgValue);
        }

        return true;
    }

    /**
     * @dev Callback function for Zkevm bridge.
     * Verifies the received message.
     * @inheritdoc IBridgeMessageReceiver
     */
    function onMessageReceived(
        address,
        uint32,
        bytes memory data
    ) external payable override {
        require(
            msg.sender == address(zkEvmBridge),
            "PolygonZkevmV2Ism: invalid sender"
        );
        require(data.length == 32, "PolygonZkevmV2Ism: data must be 32 bytes");
        require(
            _isAuthorized(),
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        require(
            msg.value < 2 ** VERIFIED_MASK_INDEX,
            "AbstractMessageIdAuthorizedIsm: msg.value must be less than 2^255"
        );

        bytes32 messageId = abi.decode(data, (bytes32));
        bool verified = verifiedMessages[messageId].isBitSet(
            VERIFIED_MASK_INDEX
        );
        require(!verified, "PolygonZkevmV2Ism: message already verified");
        verifiedMessages[messageId] = msg.value.setBit(VERIFIED_MASK_INDEX);

        emit ReceivedMessage(messageId);
    }

    /**
     * @dev Checks if the origin chain message sender is the hook address.
     * @inheritdoc AbstractMessageIdAuthorizedIsm
     */
    function _isAuthorized() internal view override returns (bool) {
        bytes32 originSender = abi.decode(msg.data[4:], (bytes32));
        return originSender == authorizedHook;
    }
}
