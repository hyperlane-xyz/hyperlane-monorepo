// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../HypNative.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

/**
 * @title Hyperlane Native Token that scales native value by a fixed factor for consistency with other tokens.
 * @dev The scale factor multiplies the `message.amount` to the local native token amount.
 *      Conversely, it divides the local native `msg.value` amount by `scale` to encode the `message.amount`.
 * @author Abacus Works
 */
contract HypNativeScaled is HypNative {
    uint256 public immutable scale;

    constructor(uint256 _scale, address _mailbox) HypNative(_mailbox) {
        scale = _scale;
    }

    function _outboundAmount(
        uint256 _amount
    ) internal view override returns (uint256) {
        return _amount / scale;
    }

    function _inboundAmount(
        uint256 _amount
    ) internal view override returns (uint256) {
        return _amount * scale;
    }
}
