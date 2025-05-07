// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "./Call.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

struct AccountConfig {
    bytes32 owner;
    bytes32 ism;
    bytes32 salt;
}

/**
 * Format of message:
 * [   0:  96] Account config [owner, ISM, salt]
 * [  96:????] Calls, abi encoded
 */
library InterchainAccountMessage {
    using TypeCasts for bytes32;

    function encode(
        AccountConfig memory _accountConfig,
        CallLib.Call[] memory _calls
    ) internal pure returns (bytes memory) {
        return abi.encode(_accountConfig, _calls);
    }

    /**
     * @notice Parses and returns the calls from the provided message
     * @param _message The interchain account message
     * @return The account config and array of calls
     */
    function decode(
        bytes calldata _message
    ) internal pure returns (AccountConfig memory, CallLib.Call[] memory) {
        return abi.decode(_message, (AccountConfig, CallLib.Call[]));
    }

    function ism(bytes calldata _message) internal pure returns (address) {
        return bytes32(_message[32:64]).bytes32ToAddress();
    }
}
