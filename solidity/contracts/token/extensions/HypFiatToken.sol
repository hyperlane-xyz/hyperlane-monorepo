// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IFiatToken} from "../interfaces/IFiatToken.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

// see https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md#issuing-and-destroying-tokens
contract HypFiatToken is HypERC20Collateral {
    constructor(
        address _fiatToken,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_fiatToken, _scale, _mailbox) {}

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to burn tokens on outbound transfer.
     */
    function _transferFromSender(uint256 _amount) internal override {
        // transfer amount to address(this)
        HypERC20Collateral._transferFromSender(_amount);
        // burn amount of address(this) balance
        IFiatToken(address(wrappedToken)).burn(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        require(
            IFiatToken(address(wrappedToken)).mint(_recipient, _amount),
            "FiatToken mint failed"
        );
    }
}
