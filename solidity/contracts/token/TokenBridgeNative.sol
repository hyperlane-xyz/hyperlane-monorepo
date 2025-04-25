// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../token/HypNative.sol";
import {TokenRouter} from "../token/libs/TokenRouter.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";

abstract contract TokenBridgeNative is ITokenBridge, HypNative {
    constructor(address _mailbox) HypNative(1, _mailbox) {}

    /// @dev we have to re-implement HypNative.transferRemote here in order
    /// to pass the necessary metadata (i.e. override the gas limit)
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override(HypNative, ITokenBridge) returns (bytes32) {
        return
            HypNative._transferRemoteWithHook(
                _destination,
                _recipient,
                _amount,
                _getHookMetadata(),
                address(hook)
            );
    }

    /// @dev Implemented in derived class for customize matadata to be
    /// passed to the first dipatch
    function _getHookMetadata() internal view virtual returns (bytes memory);
}
