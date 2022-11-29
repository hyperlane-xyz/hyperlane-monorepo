// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Collateralize ERC20 token and route messages to HypERC20 tokens.
 * @author Abacus Works
 */
contract HypERC721Collateral is TokenRouter {
    IERC721 public immutable wrappedToken;

    constructor(address erc721) {
        wrappedToken = IERC721(erc721);
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
        wrappedToken.transferFrom(msg.sender, address(this), _amount);
    }

    function _transferTo(address _recipient, uint256 _amount)
        internal
        override
    {
        wrappedToken.transferFrom(address(this), _recipient, _amount);
    }
}
