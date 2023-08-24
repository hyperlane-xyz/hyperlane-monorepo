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
    mapping(address => uint256) private shareAmount;
    mapping(address => uint256) private assetsAmount;

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
        uint256 _shares = erc4626Token.deposit(_amount, address(this));
        shareAmount[msg.sender] = shareAmount[msg.sender] + _shares;
        assetsAmount[msg.sender] = assetsAmount[msg.sender] + _amount;
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
        uint256 shares = erc4626Token.withdraw(
            _amount,
            address(this),
            address(this)
        );
        if (shareAmount[_recipient] != 0) {
            if (shareAmount[_recipient] > shares) {
                shareAmount[_recipient] = shareAmount[_recipient] - shares;
            } else {
                shareAmount[_recipient] = 0;
            }
        }
        if (assetsAmount[_recipient] != 0) {
            if (assetsAmount[_recipient] > shares) {
                assetsAmount[_recipient] = assetsAmount[_recipient] - shares;
            } else {
                assetsAmount[_recipient] = 0;
            }
        }
        // send it back to user
        super._transferTo(_recipient, _amount, _metadata);
    }

    function previewRedeem(uint256 _amount) external view returns (uint256) {
        return erc4626Token.previewRedeem(_amount);
    }

    function getAssetAmount() public view returns (uint256) {
        return assetsAmount[msg.sender];
    }

    function getShareAmount() public view returns (uint256) {
        return shareAmount[msg.sender];
    }

    function takeProfit() public returns (uint256) {
        require(
            assetsAmount[msg.sender] == 0,
            "You have to withdraw all assets before take profit"
        );
        require(
            shareAmount[msg.sender] != 0,
            "Share Token must be different from 0"
        );
        uint256 shares = erc4626Token.redeem(
            shareAmount[msg.sender],
            msg.sender,
            address(this)
        );
        return shares;
    }
}
