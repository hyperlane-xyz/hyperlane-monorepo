// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "../token/HypERC20Collateral.sol";
import {TokenRouter} from "../token/libs/TokenRouter.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";

abstract contract TokenBridgeERC20 is ITokenBridge, HypERC20Collateral {
    constructor(
        address _erc20,
        address _mailbox
    ) HypERC20Collateral(_erc20, 1, _mailbox) {} // second parameter is scale

    /// @dev we have to re-implement HypERC20Collateral.transferRemote here in order
    /// to pass the necessary metadata (i.e. override the gas limit)
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        external
        payable
        virtual
        override(TokenRouter, ITokenBridge)
        returns (bytes32)
    {
        return
            TokenRouter._transferRemote(
                _destination,
                _recipient,
                _amount,
                msg.value,
                _getHookMetadata(),
                address(hook)
            );
    }

    /// @dev Implemented in derived class for customize matadata to be
    /// passed to the first dipatch
    function _getHookMetadata() internal view virtual returns (bytes memory);
}
