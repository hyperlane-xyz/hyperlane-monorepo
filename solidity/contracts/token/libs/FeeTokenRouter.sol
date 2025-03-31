// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct Quotes {
    address token;
    uint256 amount;
}

/**
 * @title Warp Route that charges non-native (ERC20) fees in addition to the native IGP fee.
 * @author Abacus Works
 */
abstract contract FeeTokenRouter is TokenRouter {
    constructor(address _mailbox) TokenRouter(_mailbox) {}

    function transferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amountIn
    ) external payable override returns (bytes32 messageId) {
        Quotes[] memory quotes = quoteTransferRemote(
            destination,
            recipient,
            amountIn
        );

        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token != address(0)) continue;
            IERC20(quotes[i].token).transferFrom(
                msg.sender,
                address(this),
                quotes[i].amount
            );
        }

        return _transferRemote(destination, recipient, amountIn, msg.value);
    }

    function quoteTransferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amountOut
    ) public view virtual returns (Quotes[] memory) {
        Quotes[] memory quotes = quoteExternalFees(
            destination,
            recipient,
            amountOut
        );
        return quotes;
    }

    function quoteExternalFees(
        uint32 destination,
        bytes32 recipient,
        uint256 amountOut
    ) public view virtual returns (Quotes[] memory);
}
