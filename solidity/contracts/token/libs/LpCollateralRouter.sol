// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {MovableCollateralRouter} from "./MovableCollateralRouter.sol";

abstract contract LpCollateralRouter is
    MovableCollateralRouter,
    ERC4626Upgradeable
{
    uint256 private lpAssets;

    event Donation(address sender, uint256 amount);

    function _LpCollateralRouter_initialize() internal onlyInitializing {
        _FungibleTokenRouter_initialize();
        __ERC4626_init(IERC20Upgradeable(_token()));
    }

    function totalAssets() public view override returns (uint256) {
        return lpAssets;
    }

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        lpAssets += assets;

        // modeled after ERC4626Upgradeable._deposit
        _transferFromSender(assets);
        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        lpAssets -= assets;

        // modeled after ERC4626Upgradeable._withdraw
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);
        _transferTo(receiver, assets, msg.data[0:0]);

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    function donate(uint256 amount) external {
        _transferFromSender(amount);
        lpAssets += amount;
        emit Donation(msg.sender, amount);
    }
}
