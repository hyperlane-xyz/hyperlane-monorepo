// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockERC4626YieldSharing
 * @dev Mock ERC4626 vault for testing yield sharing with the owner of the vault
 * @dev This is a simplified version of the Aave v3 vault here
 * https://github.com/aave/Aave-Vault/blob/main/src/ATokenVault.sol
 */
contract MockERC4626YieldSharing is ERC4626, Ownable {
    using Math for uint256;

    uint256 public constant SCALE = 1e18;
    uint256 public fee;
    uint256 public accumulatedFees;
    uint256 public lastVaultBalance;

    constructor(
        address _asset,
        string memory _name,
        string memory _symbol,
        uint256 _initialFee
    ) ERC4626(IERC20(_asset)) ERC20(_name, _symbol) {
        fee = _initialFee;
    }

    function setFee(uint256 newFee) external onlyOwner {
        require(newFee <= SCALE, "Fee too high");
        fee = newFee;
    }

    function _accrueYield() internal {
        uint256 newVaultBalance = IERC20(asset()).balanceOf(address(this));
        if (newVaultBalance > lastVaultBalance) {
            uint256 newYield = newVaultBalance - lastVaultBalance;
            uint256 newFees = newYield.mulDiv(fee, SCALE, Math.Rounding.Down);
            accumulatedFees += newFees;
            lastVaultBalance = newVaultBalance;
        }
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override returns (uint256) {
        lastVaultBalance += assets;
        return super.deposit(assets, receiver);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256) {
        _accrueYield();
        return super.redeem(shares, receiver, owner);
    }

    function getClaimableFees() public view returns (uint256) {
        uint256 newVaultBalance = IERC20(asset()).balanceOf(address(this));

        if (newVaultBalance <= lastVaultBalance) {
            return accumulatedFees;
        }

        uint256 newYield = newVaultBalance - lastVaultBalance;
        uint256 newFees = newYield.mulDiv(fee, SCALE, Math.Rounding.Down);

        return accumulatedFees + newFees;
    }

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - getClaimableFees();
    }
}
