// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../Call.sol";
import {TypeCasts} from "../TypeCasts.sol";

/**
 * Format of message:
 * [   0:  32] ICA owner
 * [  32:  64] ICA ISM
 * [  64:????] Calls, abi encoded
 */
library InterchainAccountMessage {
    using TypeCasts for bytes32;

    /**
     * @notice Returns formatted (packed) InterchainAccountMessage
     * @dev This function should only be used in memory message construction.
     * @param _owner The owner of the interchain account
     * @param _ism The address of the remote ISM
     * @param _to The address of the contract to call
     * @param _value The value to include in the call
     * @param _data The calldata
     * @return Formatted message body
     */
    function encode(
        address _owner,
        bytes32 _ism,
        address _to,
        uint256 _value,
        bytes memory _data
    ) internal pure returns (bytes memory) {
        CallLib.Call[] memory _calls = new CallLib.Call[](1);
        _calls[0] = CallLib.build(_to, _value, _data);
        return abi.encode(TypeCasts.addressToBytes32(_owner), _ism, _calls);
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
        return abi.encode(_owner, _ism, _calls);
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
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return encode(TypeCasts.addressToBytes32(_owner), _ism, _calls);
    }

    /**
     * @notice Parses and returns the calls from the provided message
     * @param _message The interchain account message
     * @return The array of calls
     */
    function decode(bytes calldata _message)
        internal
        pure
        returns (
            bytes32,
            bytes32,
            CallLib.Call[] memory
        )
    {
        return abi.decode(_message, (bytes32, bytes32, CallLib.Call[]));
    }

    /**
     * @notice Parses and returns the ISM address from the provided message
     * @param _message The interchain account message
     * @return The ISM encoded in the message
     */
    function ism(bytes calldata _message) internal pure returns (address) {
        return address(bytes20(_message[44:64]));
    }
}
