// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Quote} from "../../interfaces/ITokenBridge.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

library Quotes {
    using Address for address payable;
    using SafeERC20 for IERC20;

    function chargeSender(
        Quote[] memory quotes,
        address recipient
    ) internal returns (uint256 unspentValue) {
        uint256 nativeValue = 0;
        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token != address(0)) {
                IERC20(quotes[i].token).safeTransferFrom(
                    msg.sender,
                    recipient,
                    quotes[i].amount
                );
            } else {
                nativeValue += quotes[i].amount;
            }
        }

        if (nativeValue > 0) {
            require(
                msg.value >= nativeValue,
                "Quotes: insufficient native value"
            );
            payable(recipient).sendValue(nativeValue);
        }

        return msg.value - nativeValue;
    }
}
