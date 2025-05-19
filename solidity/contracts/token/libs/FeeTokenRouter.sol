// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct Quote {
    address token;
    uint256 amount;
}

/**
 * @title Warp Route that charges non-native (ERC20) fees in addition to the native IGP fee.
 * @author Abacus Works
 */
abstract contract FeeTokenRouter is FungibleTokenRouter {
    constructor(
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {}

    /**
     * @notice Combines two Quote arrays into a single array
     * @param quotes1 First array of Quote
     * @param quotes2 Second array of Quote
     * @return Combined array of Quote
     */
    function _combineQuote(
        Quote[] memory quotes1,
        Quote[] memory quotes2
    ) internal pure returns (Quote[] memory) {
        uint256 totalLength = quotes1.length + quotes2.length;
        Quote[] memory combined = new Quote[](totalLength);

        // Copy first array
        for (uint256 i = 0; i < quotes1.length; i++) {
            combined[i] = quotes1[i];
        }

        // Copy second array
        for (uint256 i = 0; i < quotes2.length; i++) {
            combined[quotes1.length + i] = quotes2[i];
        }

        return combined;
    }

    function quoteTransferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amountOut
    ) public view virtual returns (Quote[] memory) {
        Quote[] memory igpFees = new Quote[](1);
        igpFees[0] = Quote({
            token: address(0),
            amount: quoteGasPayment(destination)
        });
        Quote[] memory externalFees = quoteExternalFees(
            destination,
            recipient,
            amountOut
        );

        return _combineQuote(igpFees, externalFees);
    }

    function quoteExternalFees(
        uint32 destination,
        bytes32 recipient,
        uint256 amountOut
    ) public view virtual returns (Quote[] memory);
}
