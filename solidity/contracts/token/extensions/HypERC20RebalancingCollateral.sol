// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "../HypERC20Collateral.sol";

/**
 * @title Hyperlane Rebalancing Token Collateral
 * @author Abacus Works
 */
contract HypERC20RebalancingCollateral is HypERC20Collateral {
    HypERC20Collateral public immutable rebalancer;

    constructor(
        address _erc20,
        address _mailbox,
        address _rebalancer
    ) HypERC20Collateral(_erc20, _mailbox) {
        rebalancer = HypERC20Collateral(_rebalancer);
        require(
            rebalancer.wrappedToken() == wrappedToken,
            "Rebalancer collateral must match wrapped token"
        );
    }

    function transferCollateral(
        uint32 destination,
        uint256 amount
    ) external payable onlyOwner {
        bytes32 router = _mustHaveRemoteRouter(destination);
        require(wrappedToken.approve(address(rebalancer), amount));
        rebalancer.transferRemote{value: msg.value}(
            destination,
            router,
            amount
        );
    }
}
