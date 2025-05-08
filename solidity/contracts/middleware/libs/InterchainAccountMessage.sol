// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "./Call.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

struct AccountConfig {
    bytes32 owner;
    bytes32 ism;
    bytes32 salt;
}

enum MessageType {
    CALLS,
    COMMITMENT,
    REVEAL
}

library InterchainAccountMessage {
    using TypeCasts for bytes32;
    using TypeCasts for address;

    function messageType(
        bytes calldata _message
    ) internal pure returns (MessageType) {
        return MessageType(uint8(_message[0]));
    }

    function ism(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[33:65]);
    }

    function accountConfig(
        bytes calldata _message
    ) internal pure returns (AccountConfig memory) {
        assert(messageType(_message) != MessageType.REVEAL);
        return abi.decode(_message[1:97], (AccountConfig));
    }
}

library InterchainAccountMessageCalls {
    function encode(
        AccountConfig memory _accountConfig,
        CallLib.Call[] memory _calls
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                MessageType.CALLS,
                abi.encode(_accountConfig),
                abi.encode(_calls)
            );
    }

    function accountConfig(
        bytes calldata _message
    ) internal pure returns (AccountConfig memory) {
        return abi.decode(_message[1:97], (AccountConfig));
    }

    function calls(
        bytes calldata _message
    ) internal pure returns (CallLib.Call[] memory) {
        return abi.decode(_message[97:], (CallLib.Call[]));
    }
}

library InterchainAccountMessageCommitment {
    function encode(
        AccountConfig memory _accountConfig,
        bytes32 _commitment
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                MessageType.COMMITMENT,
                abi.encode(_accountConfig),
                _commitment
            );
    }

    function commitment(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[97:]);
    }
}

library InterchainAccountMessageReveal {
    function encode(
        bytes32 _ism,
        bytes32 _commitment
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(MessageType.REVEAL, _ism, _commitment);
    }

    function ism(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[1:33]);
    }

    function commitment(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[33:65]);
    }
}
