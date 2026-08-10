// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TestSwapTarget {
    using SafeERC20 for IERC20;

    address public immutable inputToken;
    address public immutable outputToken;

    bool public shouldRevert;
    uint256 public outputAmount;

    constructor(address _inputToken, address _outputToken) {
        inputToken = _inputToken;
        outputToken = _outputToken;
    }

    function setOutputAmount(uint256 _outputAmount) external {
        outputAmount = _outputAmount;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function swapExactInput(uint256 amountIn) external returns (uint256) {
        if (shouldRevert) revert("TestSwapTarget: revert");
        IERC20(inputToken).safeTransferFrom(
            msg.sender,
            address(this),
            amountIn
        );
        IERC20(outputToken).safeTransfer(msg.sender, outputAmount);
        return outputAmount;
    }
}
