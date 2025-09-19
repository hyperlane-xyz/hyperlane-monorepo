// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IWETH} from "../interfaces/IWETH.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
library NativeCollateral {
    function _transferFromSender(uint256 _amount) internal {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
    }

    function _transferTo(address _recipient, uint256 _amount) internal {
        Address.sendValue(payable(_recipient), _amount);
    }
}

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
