// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

enum FeeType {
    ZERO,
    LINEAR,
    REGRESSIVE,
    PROGRESSIVE
}

abstract contract BaseFee is Ownable, ITokenFee {
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(
        uint256 _maxFee,
        uint256 _halfAmount,
        address _owner
    ) Ownable() {
        maxFee = _maxFee;
        halfAmount = _halfAmount;
        _transferOwnership(_owner);
    }

    function claim(address token, address beneficiary) external onlyOwner {
        payable(beneficiary).transfer(address(this).balance);
        if (token != address(0)) {
            uint256 balance = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(beneficiary, balance);
        }
    }

    function feeType() external view virtual returns (FeeType);

    receive() external payable {}
}
