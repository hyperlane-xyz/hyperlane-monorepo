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

    function asset() public view override returns (address) {
        return _token();
    }

    // modeled after ERC4626Upgradeable._deposit
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        // checks
        _transferFromSender(assets);

        // effects
        lpAssets += assets;

        // interactions
        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);
    }

    // modeled after ERC4626Upgradeable._withdraw
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        // checks
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);

        // effects
        lpAssets -= assets;

        // interactions
        _transferTo(receiver, assets, msg.data[0:0]);

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    // can be used to distribute rewards to LPs pro rata
    function donate(uint256 amount) public {
        // checks
        _transferFromSender(amount);

        // effects
        lpAssets += amount;
        emit Donation(msg.sender, amount);
    }
}
