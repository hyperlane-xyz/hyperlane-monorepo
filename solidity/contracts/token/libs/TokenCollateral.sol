// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IWETH} from "../interfaces/IWETH.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

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
        token.transferFrom({
            from: msg.sender,
            to: address(this),
            tokenId: _tokenId
        });
    }

    function _transferTo(
        IERC721 token,
        address _recipient,
        uint256 _tokenId
    ) internal {
        token.safeTransferFrom({
            from: address(this),
            to: _recipient,
            tokenId: _tokenId
        });
    }
}
