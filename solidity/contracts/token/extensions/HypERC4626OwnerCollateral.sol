// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

// ============ External Imports ============
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {HypERC4626Collateral} from "./HypERC4626Collateral.sol";

/**
 * @title Hyperlane ERC4626 Token Collateral with deposits collateral to a vault, the yield goes to the owner
 * @author Abacus Works
 */
contract HypERC4626OwnerCollateral is HypERC4626Collateral {
    // Internal balance of total asset deposited
    uint256 public assetDeposited;

    event ExcessSharesSwept(uint256 amount, uint256 assetsRedeemed);

    constructor(
        ERC4626 _vault,
        uint256 _scale,
        address _mailbox
    ) HypERC4626Collateral(_vault, _scale, _mailbox) {}

    // =========== TokenRouter Overrides ============

    /**
     * @inheritdoc HypERC4626Collateral
     * @dev Overrides to track the total asset deposited.
     */
    function _depositIntoVault(
        uint256 _amount
    ) internal override returns (uint256) {
        assetDeposited += _amount;
        vault.deposit(_amount, address(this));
        return _amount;
    }

    /**
     * @inheritdoc HypERC4626Collateral
     * @dev Overrides to withdraw from the vault and track the asset deposited.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        assetDeposited -= _amount;
        vault.withdraw({
            assets: _amount,
            receiver: _recipient,
            owner: address(this)
        });
    }

    /**
     * @notice Allows the owner to redeem excess shares
     */
    function sweep() external onlyOwner {
        // convert assetsDeposited to shares rounding up to ensure
        // the owner cannot withdraw user collateral
        uint256 excessShares = vault.maxRedeem(address(this)) -
            vault.previewWithdraw(assetDeposited);
        uint256 assetsRedeemed = vault.redeem({
            shares: excessShares,
            receiver: owner(),
            owner: address(this)
        });
        emit ExcessSharesSwept(excessShares, assetsRedeemed);
    }
}
