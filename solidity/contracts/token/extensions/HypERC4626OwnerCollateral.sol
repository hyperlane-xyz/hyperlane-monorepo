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

    function _depositIntoVault(
        uint256 _amount
    ) internal virtual override returns (uint256) {
        assetDeposited += _amount;
        vault.deposit(_amount, address(this));
        return _amount;
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`, and withdraws from vault
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal virtual override {
        assetDeposited -= _amount;
        vault.withdraw(_amount, _recipient, address(this));
    }

    /**
     * @notice Allows the owner to redeem excess shares
     */
    function sweep() external onlyOwner {
        uint256 excessShares = vault.maxRedeem(address(this)) -
            vault.convertToShares(assetDeposited);
        uint256 assetsRedeemed = vault.redeem(
            excessShares,
            owner(),
            address(this)
        );
        emit ExcessSharesSwept(excessShares, assetsRedeemed);
    }
}
