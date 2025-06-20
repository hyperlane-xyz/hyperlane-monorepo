// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

abstract contract BaseFee is Ownable, ITokenFee {
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(
        uint256 _maxFee,
        uint256 _halfAmount,
        address beneficiary
    ) Ownable() {
        maxFee = _maxFee;
        halfAmount = _halfAmount;
        _transferOwnership(beneficiary);
    }

    function claim(address token) external {
        address beneficiary = owner();
        if (token == address(0)) {
            payable(beneficiary).transfer(address(this).balance);
        } else {
            IERC20(token).transfer(
                beneficiary,
                IERC20(token).balanceOf(address(this))
            );
        }
    }
}
