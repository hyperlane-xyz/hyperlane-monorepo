// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @notice Tolerates tokens that incorrectly return `false` on a successful
 * transfer, as long as exact balances moved.
 */
library SafeERC20Ext {
    using Address for address;

    function safeTransferWithBalanceCheck(
        IERC20 token,
        address recipient,
        uint256 amount
    ) internal {
        uint256 senderBalanceBefore = token.balanceOf(address(this));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);

        bytes memory returndata = address(token).functionCall(
            abi.encodeCall(IERC20.transfer, (recipient, amount))
        );

        if (returndata.length == 0 || abi.decode(returndata, (bool))) {
            return;
        }

        uint256 senderBalanceAfter = token.balanceOf(address(this));
        uint256 recipientBalanceAfter = token.balanceOf(recipient);

        require(
            senderBalanceBefore >= senderBalanceAfter &&
                senderBalanceBefore - senderBalanceAfter == amount &&
                recipientBalanceAfter >= recipientBalanceBefore &&
                recipientBalanceAfter - recipientBalanceBefore == amount,
            "SafeERC20: ERC20 operation did not succeed"
        );
    }
}
