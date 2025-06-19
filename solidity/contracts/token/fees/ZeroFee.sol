// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

contract ZeroFee is ITokenFee {
    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        return 0;
    }
}
