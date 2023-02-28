// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../Call.sol";
import {TypeCasts} from "../TypeCasts.sol";

/**
 * Format of message:
 * [   0:  32] ICA owner
 * [  32:  64] ICA ISM
 * [  65:????] Calls, abi encoded
 */
library InterchainAccountMessage {
    using TypeCasts for bytes32;

    uint256 private constant OWNER_OFFSET = 0;
    uint256 private constant ISM_OFFSET = 32;
    uint256 private constant CALLS_OFFSET = 64;

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function format(
        bytes32 _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_owner, _ism, abi.encode(_calls));
    }

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _calls The sequence of calls to make
     * @return Formatted message body
     */
    function format(
        address _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return format(TypeCasts.addressToBytes32(_owner), _ism, _calls);
    }

    /**
     * @notice Parses and returns the ICA owner from the provided message
     * @param _message The interchain account message
     * @return The ICA owner as bytes32
     */
    function owner(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[OWNER_OFFSET:ISM_OFFSET]);
    }

    /**
     * @notice Parses and returns the ISM from the provided message
     * @param _message The interchain account message
     * @return The ISM as bytes32
     */
    function ism(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[ISM_OFFSET:CALLS_OFFSET]);
    }

    /**
     * @notice Parses and returns the ISM from the provided message
     * @param _message The interchain account message
     * @return The ISM as address
     */
    function ismAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return ism(_message).bytes32ToAddress();
    }

    /**
     * @notice Parses and returns the calls from the provided message
     * @param _message The interchain account message
     * @return The array of calls
     */
    function calls(bytes calldata _message)
        internal
        pure
        returns (CallLib.Call[] memory)
    {
        return abi.decode(_message[CALLS_OFFSET:], (CallLib.Call[]));
    }
}
