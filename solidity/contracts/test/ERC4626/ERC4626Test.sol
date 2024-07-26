// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ERC4626Test is ERC4626 {
    constructor(
        address _asset,
        string memory _name,
        string memory _symbol
    ) ERC4626(IERC20(_asset)) ERC20(_name, _symbol) {}
}

contract ERC4626YieldSharing is ERC4626, Ownable {
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
        require(newFee <= 1e5, "Fee too high");
        fee = newFee;
    }

    function accrueYield() internal {
        uint256 newVaultBalance = IERC20(asset()).balanceOf(address(this));
        if (newVaultBalance > lastVaultBalance) {
            uint256 newYield = newVaultBalance - lastVaultBalance;
            uint256 newFees = (newYield * fee) / 1e4;
            accumulatedFees += newFees;
            lastVaultBalance = newVaultBalance;
        }
    }

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - accumulatedFees;
    }
}
