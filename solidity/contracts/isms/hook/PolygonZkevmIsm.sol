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
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {IPolygonZkEVMBridge} from "../../interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";
import {AbstractMessageIdAuthorizedIsm} from "../hook/AbstractMessageIdAuthorizedIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {LibBit} from "../../libs/LibBit.sol";
import {IBridgeMessageReceiver} from "../../interfaces/polygonzkevm/IBridgeMessageReceiver.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonZkevmIsm
 * @notice Polygon zkEVM chain Ism that uses the Polygon zkEVM bridge to verify messages
 */
contract PolygonZkevmIsm is
    ICcipReadIsm,
    AbstractMessageIdAuthorizedIsm,
    IBridgeMessageReceiver
{
    using Message for bytes;
    using LibBit for uint256;
    using TypeCasts for bytes32;

    IMailbox public mailbox;
    string[] public offchainUrls;

    // ============ Constants ============
    IPolygonZkEVMBridge public immutable zkEvmBridge;
    uint8 public constant override moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    // ============ Constructor ============
    constructor(
        address _zkEvmBridge,
        address _mailbox,
        string[] memory _offchainUrls
    ) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonZkevmIsm: invalid ZkEVMBridge"
        );
        require(
            Address.isContract(_mailbox),
            "PolygonZkevmIsm: invalid Mailbox"
        );
        zkEvmBridge = IPolygonZkEVMBridge(_zkEvmBridge);
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
            PolygonZkevmIsm.verify.selector,
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
        bytes calldata
    )
        external
        override(AbstractMessageIdAuthorizedIsm, IInterchainSecurityModule)
        returns (bool)
    {
        (
            bytes32[32] memory smtProof,
            uint32 index,
            bytes32 mainnetExitRoot,
            bytes32 rollupExitRoot,
            uint32 originNetwork,
            address originAddress,
            uint32 destinationNetwork,
            address destinationAddress,
            uint256 amount,
            bytes memory payload
        ) = abi.decode(
                _metadata,
                (
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

        zkEvmBridge.claimMessage(
            smtProof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            payload
        );

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
        require(data.length == 32, "PolygonZkevmIsm: data must be 32 bytes");
        require(
            _isAuthorized(),
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        require(
            msg.value < 2 ** VERIFIED_MASK_INDEX,
            "AbstractMessageIdAuthorizedIsm: msg.value must be less than 2^255"
        );

        bytes32 messageId = abi.decode(data, (bytes32));
        verifiedMessages[messageId] = msg.value.setBit(VERIFIED_MASK_INDEX);
        emit ReceivedMessage(messageId);
    }

    /**
     * @dev Checks if the origin chain message sender is the hook address.
     * @inheritdoc AbstractMessageIdAuthorizedIsm
     */
    function _isAuthorized() internal view override returns (bool) {
        require(
            msg.sender == address(zkEvmBridge),
            "PolygonZkevmIsm: invalid sender"
        );

        bytes32 originSender = abi.decode(msg.data[4:], (bytes32));
        return originSender == authorizedHook;
    }
}
