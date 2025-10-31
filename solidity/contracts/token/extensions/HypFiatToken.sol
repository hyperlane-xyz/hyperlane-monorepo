// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IFiatToken} from "../interfaces/IFiatToken.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

interface MintableERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

// see https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md#issuing-and-destroying-tokens
contract HypFiatToken is HypERC20Collateral {
    constructor(
        address _fiatToken,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_fiatToken, _scale, _mailbox) {}

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory metadata) {
        // transfer amount to address(this)
        metadata = super._transferFromSender(_amount);
        // burn amount of address(this) balance
        MintableERC20(address(wrappedToken)).burn(_amount);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata /*metadata*/
    ) internal override {
        MintableERC20(address(wrappedToken)).mint(_recipient, _amount);
    }
}
