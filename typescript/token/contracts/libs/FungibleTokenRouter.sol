// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";

/**
 * @title Hyperlane Fungible Token Router that extends the Hyperlane Token Router to accommodate
 * differences in local and interchain token decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter {
    /// @notice The number of decimals used by the token on the local chain.
    uint8 internal immutable _decimals;

    /// @notice The number of decimals used for the amount encoded in interchain messages.
    uint8 internal immutable _interchainDecimals;

    constructor(uint8 __decimals, uint8 __interchainDecimals) {
        _decimals = __decimals;
        _interchainDecimals = __interchainDecimals;
    }

    /**
     * @dev Given an amount or identifier of tokens, returns the amount to encoded in the interchain message.
     * @param _amount The amount or identifier of tokens to be sent to the remote recipient.
     */
    function _toInterchainAmount(uint256 _amount)
        internal
        view
        override
        returns (uint256)
    {
        return _convertDecimals(_decimals, _interchainDecimals, _amount);
    }

    /**
     * @dev Given an amount or identifier of tokens encoded in the interchain message, returns the amount to be minted.
     * @param _amount The amount or identifier of tokens encoded in the interchain message.
     */
    function _fromInterchainAmount(uint256 _amount)
        internal
        view
        override
        returns (uint256)
    {
        return _convertDecimals(_interchainDecimals, _decimals, _amount);
    }

    /**
     * @dev Converts an amount from one decimal representation to another.
     * @param _fromDecimals The number of decimals in the original representation.
     * @param _toDecimals The number of decimals in the target representation.
     * @param _amount The amount to be converted.
     * @return The converted amount.
     */
    function _convertDecimals(
        uint8 _fromDecimals,
        uint8 _toDecimals,
        uint256 _amount
    ) internal pure returns (uint256) {
        if (_fromDecimals == _toDecimals) {
            return _amount;
        } else if (_fromDecimals > _toDecimals) {
            return _amount / (10**(_fromDecimals - _toDecimals));
        } else {
            return _amount * (10**(_toDecimals - _fromDecimals));
        }
    }
}
