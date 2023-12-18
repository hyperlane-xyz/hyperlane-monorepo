// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";

import "forge-std/console.sol";

/**
 * @title Hyperlane ERC20 Token Collateral with deposits collateral to a vault
 * @author brolee
 */
contract HypERC20CollateralVaultDeposit is HypERC20Collateral {
    // Address of the ERC4626 compatible vault
    ERC4626 public immutable vault;

    // Internal balance of total asset deposited
    uint256 public assetDeposited;

    constructor(
        address _vault,
        address erc20,
        address _mailbox
    ) HypERC20Collateral(erc20, _mailbox) {
        vault = ERC4626(_vault);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract, and deposit into vault
     * @inheritdoc HypERC20Collateral
     */
    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory metadata) {
        metadata = super._transferFromSender(_amount);
        _depositIntoVault(_amount);
    }

    /**
     * @dev Deposits into the vault and increment assetDeposited
     */
    function _depositIntoVault(uint256 _amount) internal {
        wrappedToken.approve(address(vault), _amount);
        vault.deposit(_amount, address(this));
        assetDeposited += _amount;
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal virtual override {
        _withdrawFromVault(_amount);
        super._transferTo(_recipient, _amount, _metadata);
    }

    /**
     * @dev Withdraws from the vault and decrement assetDeposited
     */
    function _withdrawFromVault(uint256 _amount) internal {
        vault.withdraw(_amount, address(this), address(this));
        assetDeposited -= _amount;
    }

    /**
     * @notice Allows the owner to redeem excess shares
     */
    function sweep() external onlyOwner {
        if (_excessVaultShares() > 0) {
            uint256 excessShares = vault.maxRedeem(address(this)) -
                vault.convertToShares(assetDeposited);
            vault.redeem(excessShares, owner(), address(this));
        }
    }

    /**
     * @notice Calculates excess vault shares using the converted assetDeposited and max redeemable shares
     * @return excess vault shares or 0
     */
    function _excessVaultShares() internal view returns (uint256) {
        return
            vault.maxRedeem(address(this)) >
                vault.convertToShares(assetDeposited)
                ? vault.maxRedeem(address(this)) -
                    vault.convertToShares(assetDeposited)
                : 0;
    }
}
