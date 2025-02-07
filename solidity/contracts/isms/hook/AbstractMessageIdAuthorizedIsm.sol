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
import {PackageVersioned} from "contracts/PackageVersioned.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title AbstractMessageIdAuthorizedIsm
 * @notice Uses external verification options to verify interchain messages which need an authorized caller
 */
abstract contract AbstractMessageIdAuthorizedIsm is
    IInterchainSecurityModule,
    Initializable,
    PackageVersioned
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
    /// @notice address for the authorized hook
    bytes32 public authorizedHook;

    // ============ Events ============

    /// @notice Emitted when a message is received from the external bridge
    event ReceivedMessage(bytes32 indexed messageId, uint256 msgValue);

    // ============ Initializer ============

    function setAuthorizedHook(bytes32 _hook) external initializer {
        require(
            _hook != bytes32(0),
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
        /*metadata*/
        bytes calldata message
    ) external virtual returns (bool) {
        bool verified = isVerified(message);
        if (verified) {
            _releaseValueToRecipient(message);
        }
        return verified;
    }

    // ============ Public Functions ============

    /**
     * @notice Check if a message is verified through preVerifyMessage first.
     * @param message Message to check.
     */
    function isVerified(bytes calldata message) public view returns (bool) {
        bytes32 messageId = message.id();
        // check for the first bit (used for verification)
        return verifiedMessages[messageId].isBitSet(VERIFIED_MASK_INDEX);
    }

    /**
     * @notice Receive a message from the AbstractMessageIdAuthHook
     * @dev Only callable by the authorized hook.
     * @param messageId Hyperlane Id of the message.
     */
    function preVerifyMessage(
        bytes32 messageId,
        uint256 msgValue
    ) public payable virtual {
        require(
            _isAuthorized(),
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        require(
            msg.value < 2 ** VERIFIED_MASK_INDEX && msg.value == msgValue,
            "AbstractMessageIdAuthorizedIsm: invalid msg.value"
        );
        require(
            verifiedMessages[messageId] == 0,
            "AbstractMessageIdAuthorizedIsm: message already verified"
        );

        verifiedMessages[messageId] = msg.value.setBit(VERIFIED_MASK_INDEX);
        emit ReceivedMessage(messageId, msgValue);
    }

    // ============ Internal Functions ============

    /**
     * @notice Release the value to the recipient if the message is verified.
     * @param message Message to release value for.
     */
    function _releaseValueToRecipient(bytes calldata message) internal {
        bytes32 messageId = message.id();
        uint256 _msgValue = verifiedMessages[messageId].clearBit(
            VERIFIED_MASK_INDEX
        );
        if (_msgValue > 0) {
            verifiedMessages[messageId] -= _msgValue;
            payable(message.recipientAddress()).sendValue(_msgValue);
        }
    }

    /**
     * @notice Check if sender is authorized to message `preVerifyMessage`.
     */
    function _isAuthorized() internal view virtual returns (bool);
}
