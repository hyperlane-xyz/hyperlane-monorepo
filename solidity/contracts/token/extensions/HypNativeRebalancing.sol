// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../HypNative.sol";

/**
 * @title Hyperlane Rebalancing Native Collateral
 * @author Abacus Works
 */
contract HypERC20RebalancingCollateral is HypNative {
    HypNative public immutable rebalancer;

    constructor(
        address _mailbox,
        address payable _rebalancer
    ) HypNative(_mailbox) {
        rebalancer = HypNative(_rebalancer);
    }

    function transferCollateral(
        uint32 destination,
        uint256 amount
    ) external payable onlyOwner {
        bytes32 router = _mustHaveRemoteRouter(destination);
        uint256 payment = msg.value + amount;
        require(address(this).balance >= payment, "Insufficient balance");
        rebalancer.transferRemote{value: payment}(destination, router, amount);
    }
}
