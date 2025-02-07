// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPaymentCoordinator} from "../../interfaces/avs/vendored/IPaymentCoordinator.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TestPaymentCoordinator is IPaymentCoordinator {
    using SafeERC20 for IERC20;

    function payForRange(RangePayment[] calldata rangePayments) external {
        for (uint256 i = 0; i < rangePayments.length; i++) {
            rangePayments[i].token.safeTransferFrom(
                msg.sender,
                address(this),
                rangePayments[i].amount
            );
        }
    }
}
