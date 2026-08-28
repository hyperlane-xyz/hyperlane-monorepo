// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @title MockERC4626YieldSharing
 * @notice Realistic ERC-4626 yield strategy mock simulating dynamic APR and yield accretion over time.
 */
contract MockERC4626YieldSharing is ERC4626 {
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    uint256 public aprBps; // Annual percentage rate in basis points (e.g. 1000 = 10%)
    uint256 public lastYieldAccrual;
    uint256 public simulatedLossBps;

    event YieldAdded(uint256 amount, uint256 newTotalAssets);
    event AprUpdated(uint256 oldAprBps, uint256 newAprBps);

    constructor(
        IERC20 _asset,
        string memory _name,
        string memory _symbol
    )
        ERC20(_name, _symbol)
        ERC4626(_asset)
    {
        lastYieldAccrual = block.timestamp;
    }

    /**
     * @notice Manually adds yield by minting underlying assets directly to the vault contract.
     * @param amount Amount of underlying assets to add as yield.
     */
    function addYield(uint256 amount) external {
        MockERC20(address(asset())).mint(address(this), amount);
        emit YieldAdded(amount, totalAssets());
    }

    /**
     * @notice Simulates yield percentage gain based on current total assets.
     * @param basisPoints Percentage gain in basis points (e.g. 500 = 5%).
     */
    function simulateYield(uint256 basisPoints) external {
        uint256 currentAssets = totalAssets();
        uint256 yieldAmount = (currentAssets * basisPoints) / BPS_DENOMINATOR;
        if (yieldAmount > 0) {
            MockERC20(address(asset())).mint(address(this), yieldAmount);
            emit YieldAdded(yieldAmount, totalAssets());
        }
    }

    /**
     * @notice Sets annual APR for automatic yield accrual.
     */
    function setYieldApr(uint256 _aprBps) external {
        accrueYield();
        emit AprUpdated(aprBps, _aprBps);
        aprBps = _aprBps;
    }

    /**
     * @notice Accrues interest/yield based on configured APR and elapsed time.
     */
    function accrueYield() public {
        uint256 elapsed = block.timestamp - lastYieldAccrual;
        if (elapsed > 0 && aprBps > 0) {
            uint256 currentAssets = totalAssets();
            if (currentAssets > 0) {
                uint256 yieldEarned = (currentAssets * aprBps * elapsed) / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
                if (yieldEarned > 0) {
                    MockERC20(address(asset())).mint(address(this), yieldEarned);
                }
            }
        }
        lastYieldAccrual = block.timestamp;
    }

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        accrueYield();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        accrueYield();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        accrueYield();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        accrueYield();
        return super.redeem(shares, receiver, owner);
    }
}
