// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ILiquidityLayerMessageRecipient} from "../interfaces/ILiquidityLayerMessageRecipient.sol";

contract TestLiquidityLayerMessageRecipient is ILiquidityLayerMessageRecipient {
    event HandledWithTokens(
        uint32 origin,
        bytes32 sender,
        bytes message,
        address token,
        uint256 amount
    );

    function handleWithTokens(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message,
        address _token,
        uint256 _amount
    ) external {
        emit HandledWithTokens(_origin, _sender, _message, _token, _amount);
    }
}
