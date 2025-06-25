// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {LpCollateralRouter} from "../token/libs/LpCollateralRouter.sol";
import {FungibleTokenRouter} from "../token/libs/FungibleTokenRouter.sol";

contract TestLpCollateralRouter is LpCollateralRouter {
    mapping(address => uint256) public debited;
    mapping(address => uint256) public credited;

    constructor(
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) initializer {
        _LpCollateralRouter_initialize();
    }

    function token() public view override returns (address) {
        return address(0);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        debited[msg.sender] += _amount;
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata
    ) internal override {
        credited[_recipient] += _amount;
    }
}
