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
import {LibBit} from "../../libs/LibBit.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title AbstractMessageIdAuthorizedIsm
 * @notice Uses external verfication options to verify interchain messages which need a authorized caller
 */
abstract contract AbstractMessageIdAuthorizedIsm is
    IInterchainSecurityModule,
    Initializable,
    MailboxClient
{
    using Address for address payable;
    using LibBit for uint256;
    using Message for bytes;
    // ============ Public Storage ============

    /// @notice Maps messageId to whether or not the message has been verified
    /// first bit is boolean for verification
    /// rest of bits is the amount to send to the recipient
    /// @dev bc of the bit packing, we can only send up to 2^255 wei
    /// @dev the first bit is reserved for verification and the rest 255 bits are for the msg.value
    mapping(bytes32 => uint256) public verifiedMessages;
    /// @notice Index of verification bit in verifiedMessages
    uint256 public constant VERIFIED_MASK_INDEX = 255;
    /// @notice Address for the authorized hook
    address public authorizedHook;

    // ============ Events ============

    /// @notice Emitted when a message is received from the external bridge
    event ReceivedMessage(bytes32 indexed messageId);

    // ============ Constructor ============

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    // ============ Initializer ============

    function setAuthorizedHook(address _hook) external initializer {
        require(
            _hook != address(0),
            "AbstractMessageIdAuthorizedIsm: invalid authorized hook"
        );
        authorizedHook = _hook;
    }

    // ============ External Functions ============

    /**
     * @notice Verify a message was received by ISM.
     * @param message Message to verify.
     */
    function verify(
        bytes calldata,
        /*_metadata*/
        bytes calldata message
    ) external returns (bool) {
        bytes32 messageId = message.id();

        // check for the first bit (used for verification)
        // rest 255 bits contains the msg.value passed from the hook
        bool verified = verifiedMessages[messageId].isBitSet(
            VERIFIED_MASK_INDEX
        );
        // protecting against non-mailbox front running of verify()
        _checkDelivered(messageId);
        if (verified) {
            payable(message.recipientAddress()).sendValue(
                verifiedMessages[messageId].clearBit(VERIFIED_MASK_INDEX)
            );
        }
        return verified;
    }

    /**
     * @notice Receive a message from the AbstractMessageIdAuthHook
     * @dev Only callable by the authorized hook.
     * @param messageId Hyperlane Id of the message.
     */
    function verifyMessageId(bytes32 messageId) external payable virtual {
        require(
            _isAuthorized(),
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );

        verifiedMessages[messageId] = msg.value.setBit(VERIFIED_MASK_INDEX);
        emit ReceivedMessage(messageId);
    }

    function _isAuthorized() internal view virtual returns (bool);

    /**
     * @notice returns if the message has been delivered by the mailbox
     * @dev to protect against front running of verify() which would mean
     * the actual message won't be delivered
     * @param messageId Hyperlane Id of the message.
     * @return true if the message has been delivered
     */
    function _checkDelivered(bytes32 messageId) internal view returns (bool) {
        return mailbox.processor(messageId) != address(0);
    }
}
