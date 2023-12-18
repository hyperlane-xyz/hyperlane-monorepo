// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title Hyperlane ERC20 Token Collateral deposits collateral to a vault
 * @author brolee
 */
contract HypERC20CollateralVaultDeposit is HypERC20Collateral {
    // Address of the ERC4626 compatible vault
    ERC4626 public immutable vault;

    // Internal balance of total vault shares
    uint256 public shares;

    constructor(
        address _vault,
        address erc20,
        address _mailbox
    ) HypERC20Collateral(erc20, _mailbox) {
        vault = ERC4626(_vault);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory metadata) {
        metadata = super._transferFromSender(_amount);
        _depositIntoVault(_amount);
    }

    function _depositIntoVault(uint256 _amount) internal {
        wrappedToken.approve(address(vault), _amount);
        shares += vault.deposit(_amount, address(this));
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal virtual override {
        // TODO maybe Get slippage from meta data
        shares -= vault.withdraw(_amount, address(this), address(this));
        super._transferTo(_recipient, _amount, _metadata);
    }
}
