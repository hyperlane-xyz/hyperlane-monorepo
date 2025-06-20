// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

interface ITokenFee {
    function quoteTransfer(uint256 amount) external view returns (uint256 fee);
}
