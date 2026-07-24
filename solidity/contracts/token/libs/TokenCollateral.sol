// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IWETH} from "../interfaces/IWETH.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title Handles deposits and withdrawals of native token collateral.
 */
library NativeCollateral {
    function _transferFromSender(uint256 _amount) internal {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
    }

    function _transferTo(address _recipient, uint256 _amount) internal {
        Address.sendValue(payable(_recipient), _amount);
    }
}

/**
 * @title Handles deposits and withdrawals of WETH collateral.
 * @dev TokenRouters must have `token() == address(0)` to use this library.
 */
library WETHCollateral {
    function _transferFromSender(IWETH token, uint256 _amount) internal {
        NativeCollateral._transferFromSender(_amount);
        token.deposit{value: _amount}();
    }

    function _transferTo(
        IWETH token,
        address _recipient,
        uint256 _amount
    ) internal {
        token.withdraw(_amount);
        NativeCollateral._transferTo(_recipient, _amount);
    }
}

/**
 * @title Handles deposits and withdrawals of ERC20 collateral.
 */
library ERC20Collateral {
    using SafeERC20 for IERC20;

    function _transferFromSender(IERC20 token, uint256 _amount) internal {
        token.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function _transferTo(
        IERC20 token,
        address _recipient,
        uint256 _amount
    ) internal {
        token.safeTransfer(_recipient, _amount);
    }
}

/**
 * @title Handles deposits and withdrawals of ERC721 collateral.
 */
library ERC721Collateral {
    function _transferFromSender(IERC721 token, uint256 _tokenId) internal {
        // safeTransferFrom not used here because recipient is this contract
        token.transferFrom(msg.sender, address(this), _tokenId);
    }

    function _transferTo(
        IERC721 token,
        address _recipient,
        uint256 _tokenId
    ) internal {
        token.safeTransferFrom(address(this), _recipient, _tokenId);
    }
}

/**
 * @title Reads the effective (non-reclaimable) collateral held by an ERC4626 LP
 * vault (e.g. an `LpCollateralRouter`).
 */
library LpCollateral {
    /**
     * @notice The vault's collateral balance excluding the pool reclaimable by
     * LP share holders: `balance - totalAssets()`, clamped at 0.
     * @dev The raw balance is the vault's holding of its `asset()`, or its
     * native balance when `asset() == address(0)` (HypNative). `totalAssets()`
     * is the LP-redeemable pool, so netting it out leaves only genuinely locked
     * collateral and irreversible transfers.
     */
    function effectiveCollateralBalance(
        IERC4626 vault
    ) internal view returns (uint256) {
        address asset = vault.asset();
        uint256 balance = asset == address(0)
            ? address(vault).balance
            : IERC20(asset).balanceOf(address(vault));
        uint256 reclaimable = vault.totalAssets();
        return balance > reclaimable ? balance - reclaimable : 0;
    }
}
