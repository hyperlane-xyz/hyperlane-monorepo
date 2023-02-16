// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../Call.sol";
import {TypeCasts} from "../TypeCasts.sol";

/**
 * Format of metadata:
 * [   0:  32] ICA owner
 * [  32:  64] ICA ISM
 * [  65:????] Calls, abi encoded
 */
library InterchainAccountMessage {
    using TypeCasts for bytes32;

    uint256 private constant OWNER_OFFSET = 0;
    uint256 private constant ISM_OFFSET = 32;
    uint256 private constant CALLS_OFFSET = 64;

    function format(
        bytes32 _owner,
        bytes32 _ism,
        CallLib.Call[] calldata _calls
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_owner, _ism, abi.encode(_calls));
    }

    function owner(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[OWNER_OFFSET:ISM_OFFSET]);
    }

    function ism(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[ISM_OFFSET:CALLS_OFFSET]);
    }

    function ismAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return ism(_message).bytes32ToAddress();
    }

    function calls(bytes calldata _message)
        internal
        pure
        returns (CallLib.Call[] memory _calls)
    {
        return abi.decode(_message[CALLS_OFFSET:], (CallLib.Call[]));
    }
}
