// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {MovableCollateralRouter, MovableCollateralRouterStorage} from "./MovableCollateralRouter.sol";

// ============ External Imports ============
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

struct LpCollateralRouterStorage {
    // MovableCollateralRouter layout
    MovableCollateralRouterStorage __MOVABLE_COLLATERAL_GAP;
    // ERC4626 layout
    // - (ERC20 layout)
    mapping(address => uint256) _balances;
    mapping(address => mapping(address => uint256)) _allowances;
    uint256 _totalSupply;
    string _name;
    string _symbol;
    // @openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol:376
    uint256[45] __ERC20_GAP;
    // - (ERC4626 layout)
    address _asset;
    uint8 _underlyingDecimals;
    // @openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol:267
    uint256[49] __ERC4626_GAP;
    // user defined fields
    uint256 lpAssets;
}

abstract contract LpCollateralRouter is
    MovableCollateralRouter,
    ERC4626Upgradeable
{
    uint256 private lpAssets;

    event Donation(address sender, uint256 amount);

    function _LpCollateralRouter_initialize() internal onlyInitializing {
        __ERC4626_init(IERC20Upgradeable(token()));
    }

    function totalAssets() public view override returns (uint256) {
        return lpAssets;
    }

    function asset() public view override returns (address) {
        return token();
    }

    // modeled after ERC4626Upgradeable._deposit
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        // checks
        _transferFromSender(assets);

        // effects
        lpAssets += assets;

        // interactions
        _mint(receiver, shares);

        emit Deposit({
            sender: caller,
            owner: receiver,
            assets: assets,
            shares: shares
        });
    }

    // modeled after ERC4626Upgradeable._withdraw
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        // checks
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);

        // effects
        lpAssets -= assets;

        // interactions
        _transferTo(receiver, assets);

        emit Withdraw({
            sender: caller,
            receiver: receiver,
            owner: owner,
            assets: assets,
            shares: shares
        });
    }

    // can be used to distribute rewards to LPs pro rata
    function donate(uint256 amount) public payable {
        // checks
        _transferFromSender(amount);

        // effects
        lpAssets += amount;
        emit Donation(msg.sender, amount);
    }
}
