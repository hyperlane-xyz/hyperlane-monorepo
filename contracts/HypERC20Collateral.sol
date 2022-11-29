// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Collateralize ERC20 token and route messages to HypERC20 tokens.
 * @author Abacus Works
 */
contract HypERC20Collateral is TokenRouter {
    IERC20 public immutable wrappedToken;

    constructor(address erc20) {
        wrappedToken = IERC20(erc20);
    }

    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule
        );
    }

    function _transferFromSender(uint256 _amount) internal override {
        require(wrappedToken.transferFrom(msg.sender, address(this), _amount));
    }

    function _transferTo(address _recipient, uint256 _amount)
        internal
        override
    {
        require(wrappedToken.transfer(_recipient, _amount));
    }
}
