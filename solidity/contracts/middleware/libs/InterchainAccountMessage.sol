// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "./Call.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * Format of CALLS message:
 * [   0:   1] MessageType.CALLS (uint8)
 * [   1:  33] ICA owner (bytes32)
 * [  33:  65] ICA ISM (bytes32)
 * [  65:  97] User Salt (bytes32)
 * [  97:????] Calls (CallLib.Call[]), abi encoded
 *
 * Format of COMMITMENT message:
 * [   0:   1] MessageType.COMMITMENT (uint8)
 * [   1:  33] ICA owner (bytes32)
 * [  33:  65] ICA ISM (bytes32)
 * [  65:  97] User Salt (bytes32)
 * [  97: 129] Commitment (bytes32)
 */
library InterchainAccountMessage {
    using TypeCasts for bytes32;
    using TypeCasts for address;

    enum MessageType {
        CALLS,
        COMMITMENT,
        REVEAL
    }

    bytes32 internal constant EMPTY_SALT = bytes32(0);

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function encode(
        address _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return encode(TypeCasts.addressToBytes32(_owner), _ism, _calls);
    }

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function encode(
        bytes32 _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return encode(_owner, _ism, _calls, EMPTY_SALT);
    }

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function encode(
        address _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes32 _userSalt
    ) internal pure returns (bytes memory) {
        return
            encode(TypeCasts.addressToBytes32(_owner), _ism, _calls, _userSalt);
    }

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function encode(
        bytes32 _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls,
        bytes32 _userSalt
    ) internal pure returns (bytes memory) {
        bytes memory prefix = abi.encodePacked(
            MessageType.CALLS,
            _owner,
            _ism,
            _userSalt
        );
        bytes memory suffix = abi.encode(_calls);
        return bytes.concat(prefix, suffix);
    }

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @return Formatted message body
     */
    function encodeCommitment(
        bytes32 _owner,
        bytes32 _ism,
        bytes32 _commitment,
        bytes32 _userSalt
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                MessageType.COMMITMENT,
                _owner,
                _ism,
                _userSalt,
                _commitment
            );
    }

    function encodeReveal(
        bytes32 _ism,
        bytes32 _commitment
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(MessageType.REVEAL, _ism, _commitment);
    }

    function messageType(
        bytes calldata _message
    ) internal pure returns (MessageType) {
        return MessageType(uint8(_message[0]));
    }

    function owner(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[1:33]);
    }

    /**
     * @notice Parses and returns the ISM address from the provided message
     * @param _message The interchain account message
     * @return The ISM encoded in the message
     */
    function ism(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[33:65]);
    }

    function salt(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[65:97]);
    }

    function calls(
        bytes calldata _message
    ) internal pure returns (CallLib.Call[] memory) {
        return abi.decode(_message[97:], (CallLib.Call[]));
    }

    function commitment(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[97:]);
    }
}

/**
 * Format of REVEAL message:
 * [   0:  1] MessageType.REVEAL (uint8)
 * [   1: 33] ICA ISM (bytes32)
 * [  33: 65] Commitment (bytes32)
 */
library InterchainAccountMessageReveal {
    function revealIsm(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[1:33]);
    }

    function revealCommitment(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[33:65]);
    }
}
