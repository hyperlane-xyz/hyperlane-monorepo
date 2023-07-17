// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC20CollateralSaving is HypERC20Collateral {
    ERC4626 public immutable erc4626Token;
    uint256 private totalCollateralAssets;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(address erc20, address erc4626) HypERC20Collateral(erc20) {
        erc4626Token = ERC4626(erc4626);

        // approve to erc4626
        uint256 amount = type(uint256).max; // Maximum value of uint256
        wrappedToken.approve(erc4626, amount);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc HypERC20Collateral
     */
    function _transferFromSender(uint256 _amount)
        internal
        override
        returns (bytes memory)
    {
        super._transferFromSender(_amount);
        // deposit to vault contract
        erc4626Token.deposit(_amount, address(this));
        totalCollateralAssets = totalCollateralAssets + _amount;
        return bytes(""); // no metadata
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata // no metadata
    ) internal override {
        uint256 redeemAmount = _convertToRedeemToken(_amount);
        // redeem token from vault
        uint256 amount = erc4626Token.redeem(
            redeemAmount,
            address(this),
            address(this)
        );
        // send it back to user
        super._transferTo(_recipient, amount, _metadata);
        totalCollateralAssets = totalCollateralAssets - _amount;
    }

    function previewRedeem(uint256 _amount) external view returns (uint256) {
        return erc4626Token.previewRedeem(_convertToRedeemToken(_amount));
    }

    function _convertToRedeemToken(uint256 _amount)
        internal
        view
        virtual
        returns (uint256)
    {
        return
            (_amount * erc4626Token.balanceOf(address(this))) /
            totalCollateralAssets;
    }
}
